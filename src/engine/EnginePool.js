/**
 * EnginePool
 *
 * Manages a fixed-size pool of persistent StockfishProcess instances.
 * Provides a single evaluate() surface with built-in FIFO queuing and
 * overflow protection.
 *
 * Concurrency model:
 *   - Free engine available  → run immediately
 *   - All engines busy       → enqueue (FIFO), max configurable depth
 *   - Queue full             → throw "Engine overloaded" (→ 503)
 *
 * Lifecycle:
 *   const pool = new EnginePool({ binaryPath, size: 2 });
 *   await pool.init();
 *   const result = await pool.evaluate(fen, depth);
 *   await pool.quit();
 *
 * Signal handling (SIGTERM / SIGINT) is registered ONCE here, not per
 * engine, because process.once() silently drops duplicate listeners.
 */

import { StockfishProcess } from "./StockfishProcess.js";

const DEFAULT_MAX_QUEUE = 10;

export class EnginePool {
  /**
   * @param {object} options
   * @param {string} options.binaryPath   Path to the Stockfish binary
   * @param {number} [options.size=2]     Number of engine instances
   * @param {number} [options.multiPV=3]  Lines per analysis
   * @param {number} [options.threads=1]  Threads per engine (keep 1 on Railway Hobby)
   * @param {number} [options.maxQueue=10] Max queued requests before overflow
   */
  constructor({ binaryPath, size = 2, multiPV = 3, threads = 1, maxQueue = DEFAULT_MAX_QUEUE }) {
    this._engines   = Array.from({ length: size }, () =>
      new StockfishProcess(binaryPath, { multiPV, threads })
    );

    // Available engines — FIFO via shift/push.
    // At startup all engines are idle; populated after init().
    this._available = [];

    // Pending caller queue — FIFO.
    // Each slot: { fen, depth, resolve, reject }
    this._queue    = [];
    this._maxQueue = maxQueue;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Initialize all engine instances in parallel and register signal handlers.
   * Must be called (and awaited) before evaluate().
   */
  async init() {
    await Promise.all(this._engines.map((e) => e.init()));

    // All engines start idle
    this._available = [...this._engines];

    console.log(`[EnginePool] ${this._engines.length} engine(s) ready.`);

    // Register shutdown signals ONCE at the pool level.
    const shutdown = async (signal) => {
      console.log(`[EnginePool] Received ${signal} — shutting down pool.`);
      await this.quit();
      process.exit(0);
    };

    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT",  () => shutdown("SIGINT"));
  }

  /**
   * Evaluate a FEN position using any available engine.
   *
   * @param {string} fen
   * @param {number} depth  Capped upstream; passed through to engine.
   * @returns {Promise<EvalResult>}
   * @throws {Error} "Engine overloaded" if queue is full
   */
  async evaluate(fen, depth) {
    // Guard: all engines may have been discarded due to crashes
    if (this._engines.length === 0) {
      throw new Error("No engines available");
    }

    // Idle engine available — use it immediately
    if (this._available.length > 0) {
      const engine = this._available.shift();
      return this._runOnEngine(engine, fen, depth);
    }

    // All busy — queue or reject
    if (this._queue.length >= this._maxQueue) {
      throw new Error("Engine overloaded");
    }

    return new Promise((resolve, reject) => {
      this._queue.push({ fen, depth, resolve, reject });
    });
  }

  /**
   * Return pool status for health / monitoring endpoints.
   *
   * @returns {{ totalEngines, busyEngines, queueLength }}
   */
  getStatus() {
    return {
      totalEngines: this._engines.length,
      busyEngines:  this._engines.length - this._available.length,
      queueLength:  this._queue.length,
    };
  }

  /**
   * Reject all queued requests and shut down every engine cleanly.
   */
  async quit() {
    // Drain queue — callers waiting must receive a rejection
    for (const { reject } of this._queue) {
      reject(new Error("Engine pool shutting down"));
    }
    this._queue     = [];
    this._available = [];

    await Promise.all(this._engines.map((e) => e.quit()));
    console.log("[EnginePool] All engines stopped.");
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  /**
   * Run an evaluation on a specific (already-acquired) engine instance.
   * Always releases the engine back to the pool on completion or error.
   *
   * Defensive sync-throw guard: engine.evaluate() could throw synchronously
   * (e.g. engine process died between being acquired and used). In that case
   * the .then/.catch chain never forms, so we must catch it here and still
   * release the engine (or discard it if dead) so the pool stays consistent.
   *
   * @param {StockfishProcess} engine
   * @param {string} fen
   * @param {number} depth
   * @returns {Promise<EvalResult>}
   */
  _runOnEngine(engine, fen, depth) {
    let p;
    try {
      p = engine.evaluate(fen, depth);
    } catch (err) {
      // Sync throw — engine likely died. Discard it and release the slot
      // so the pool can continue serving other callers.
      this._discardOrRelease(engine, err);
      return Promise.reject(err);
    }

    return p.then(
      (result) => {
        this._release(engine);
        return result;
      },
      (err) => {
        this._discardOrRelease(engine, err);
        throw err;
      }
    );
  }

  /**
   * Decide whether a post-eval engine is still usable.
   *
   * If the engine is dead (not ready), remove it from the pool permanently
   * and reject any waiting callers with a clear error rather than silently
   * handing them a broken engine.
   *
   * TODO Phase 2: spawn a replacement engine here and push it to _available.
   *
   * @param {StockfishProcess} engine
   * @param {Error}            err     The error that caused the release
   */
  _discardOrRelease(engine, err) {
    if (!engine._ready) {
      // Engine process has exited — remove it from both the master list and
      // the available pool (defensive: it shouldn't be in _available while
      // busy, but filter anyway to prevent a broken reference leaking back).
      this._engines   = this._engines.filter((e) => e !== engine);
      this._available = this._available.filter((e) => e !== engine);
      console.error(
        `[EnginePool] Engine discarded after crash (${err.message}). ` +
        `Pool capacity: ${this._engines.length} engine(s).`
      );
      // Drain one queued caller with the crash error so it's not stuck.
      if (this._queue.length > 0) {
        const { reject } = this._queue.shift();
        reject(new Error("Engine crashed — no replacement available yet"));
      }
      return;
    }
    // Engine is still alive — return it normally.
    this._release(engine);
  }

  /**
   * Return a healthy engine to the pool.
   * If a caller is waiting in the FIFO queue, dispatch directly — the engine
   * never touches _available, eliminating any acquisition race.
   *
   * @param {StockfishProcess} engine
   */
  _release(engine) {
    if (this._queue.length > 0) {
      // Dequeue oldest waiting caller — FIFO
      const { fen, depth, resolve, reject } = this._queue.shift();
      // Hand engine directly to queued work; never enters _available
      this._runOnEngine(engine, fen, depth).then(resolve).catch(reject);
    } else {
      // No pending work — return engine to idle pool
      this._available.push(engine);
    }
  }
}
