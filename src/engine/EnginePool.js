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
import { cacheGet, cacheSet } from "../cache/RedisCache.js";
import { logInfo, logWarn, logError } from "../observability/logger.js";

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
    // Store config for auto-respawn
    this._binaryPath = binaryPath;
    this._multiPV    = multiPV;
    this._threads    = threads;
    this._poolSize   = size;

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

    // Track in-flight respawn attempts to avoid spawning more than pool size
    this._respawning = 0;
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

    // Periodic health watchdog: every 2 minutes, check if pool is depleted
    // and trigger respawn if needed. Guards against engines crashing silently.
    this._watchdog = setInterval(() => {
      const live = this._engines.length + this._respawning;
      if (live < this._poolSize) {
        const needed = this._poolSize - live;
        console.warn(`[EnginePool] Watchdog: only ${live}/${this._poolSize} engines alive — spawning ${needed} replacement(s).`);
        for (let i = 0; i < needed; i++) this._respawnEngine();
      }
    }, 2 * 60 * 1_000).unref();
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
    const startedAt = process.hrtime.bigint();
    // Guard: all engines have crashed AND no respawn is underway
    if (this._engines.length === 0 && this._respawning === 0) {
      logError("enginepool_no_engines", {
        feature: "evaluation",
        depth,
        queueLength: this._queue.length,
        available: this._available.length,
        totalEngines: this._engines.length,
        respawning: this._respawning,
      });
      throw new Error("No engines available");
    }

    // ── Cache check (Redis L1) ─────────────────────────────────────────────
    // Returns null when cache is disabled or on any Redis error — no-op.
    const cached = await cacheGet(fen, depth);
    if (cached) {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logInfo("enginepool_cache_hit", {
        feature: "evaluation",
        depth,
        latencyMs: Math.round(latencyMs),
        queueLength: this._queue.length,
        available: this._available.length,
        totalEngines: this._engines.length,
      });
      return cached;
    }

    // ── Engine dispatch ────────────────────────────────────────────────────
    // Idle engine available — use it immediately
    if (this._available.length > 0) {
      const engine = this._available.shift();
      logInfo("enginepool_dispatch_immediate", {
        feature: "evaluation",
        depth,
        queueLength: this._queue.length,
        availableAfterAcquire: this._available.length,
        totalEngines: this._engines.length,
      });
      return this._runOnEngine(engine, fen, depth);
    }

    // All busy (or respawning) — queue or reject
    if (this._queue.length >= this._maxQueue) {
      logWarn("enginepool_overloaded", {
        feature: "evaluation",
        depth,
        queueLength: this._queue.length,
        maxQueue: this._maxQueue,
        totalEngines: this._engines.length,
        respawning: this._respawning,
      });
      throw new Error("Engine overloaded");
    }

    return new Promise((resolve, reject) => {
      logInfo("enginepool_queued", {
        feature: "evaluation",
        depth,
        queueLength: this._queue.length + 1,
        maxQueue: this._maxQueue,
        totalEngines: this._engines.length,
        respawning: this._respawning,
      });
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
      respawning:   this._respawning,
    };
  }

  /**
   * Manually trigger respawn of `count` engines. Called from /recover endpoint.
   * Will not exceed ENGINE_POOL_SIZE total engines.
   *
   * @param {number} count  How many engines to spawn
   */
  forceRespawn(count) {
    const needed = Math.min(count, this._poolSize - this._engines.length - this._respawning);
    for (let i = 0; i < needed; i++) {
      this._respawnEngine();
    }
    console.log(`[EnginePool] forceRespawn triggered: ${needed} engine(s) spawning.`);
  }

  /**
   * Reject all queued requests and shut down every engine cleanly.
   */
  async quit() {
    // Stop watchdog
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }

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
    const startedAt = process.hrtime.bigint();
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
        // ── Cache write (fire-and-forget, never blocks response) ───────────
        // Both the direct-dispatch path and the queued path flow through
        // _runOnEngine(), so this single write covers all cache population.
        cacheSet(fen, depth, result).catch(() => {}); // errors handled inside cacheSet
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        logInfo("enginepool_eval_ok", {
          feature: "evaluation",
          depth,
          latencyMs: Math.round(latencyMs),
          queueLength: this._queue.length,
          totalEngines: this._engines.length,
          respawning: this._respawning,
        });
        return result;
      },
      (err) => {
        this._discardOrRelease(engine, err);
        const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        logError("enginepool_eval_error", {
          feature: "evaluation",
          depth,
          latencyMs: Math.round(latencyMs),
          queueLength: this._queue.length,
          totalEngines: this._engines.length,
          respawning: this._respawning,
          error: err,
        });
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
      logError("enginepool_engine_discarded", {
        feature: "evaluation",
        totalEngines: this._engines.length,
        respawning: this._respawning,
        error: err,
      });
      // Drain one queued caller with a retryable error — it shouldn't wait
      // behind the crash while a replacement is starting.
      if (this._queue.length > 0) {
        const { reject } = this._queue.shift();
        reject(new Error("Engine crashed — respawning, retry in a few seconds"));
      }
      // Phase 2: Auto-respawn replacement engine
      const targetSize = this._poolSize;
      const currentAlive = this._engines.length + this._respawning;
      if (currentAlive < targetSize) {
        this._respawnEngine();
      }
      return;
    }
    // Engine is still alive — return it normally.
    this._release(engine);
  }

  /**
   * Spawn a single replacement engine and add it to the pool once ready.
   * Retries up to 3 times with exponential back-off (1s, 2s, 4s).
   * Fire-and-forget — never throws; caller doesn't need to await.
   *
   * @param {number} attempt  Current attempt index (0-based)
   */
  async _respawnEngine(attempt = 0) {
    const MAX_ATTEMPTS = 3;
    this._respawning++;

    if (attempt > 0) {
      const delay = Math.min(1_000 * Math.pow(2, attempt - 1), 8_000);
      logWarn("enginepool_respawn_scheduled", {
        feature: "evaluation",
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS,
        delayMs: delay,
      });
      await new Promise((r) => setTimeout(r, delay));
    }

    const newEngine = new StockfishProcess(this._binaryPath, {
      multiPV: this._multiPV,
      threads: this._threads,
    });

    try {
      await newEngine.init();
      this._engines.push(newEngine);
      this._respawning--;
      logInfo("enginepool_respawn_ok", {
        feature: "evaluation",
        totalEngines: this._engines.length,
        respawning: this._respawning,
      });
      // Hand it to any waiting caller, or park it idle
      this._release(newEngine);
    } catch (spawnErr) {
      this._respawning--;
      logError("enginepool_respawn_failed", {
        feature: "evaluation",
        attempt: attempt + 1,
        maxAttempts: MAX_ATTEMPTS,
        error: spawnErr,
      });
      if (attempt + 1 < MAX_ATTEMPTS) {
        this._respawnEngine(attempt + 1);
      } else {
        logError("enginepool_respawn_exhausted", { feature: "evaluation" });
      }
    }
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
      logInfo("enginepool_dequeue", {
        feature: "evaluation",
        depth,
        queueLength: this._queue.length,
        totalEngines: this._engines.length,
        respawning: this._respawning,
      });
      // Hand engine directly to queued work; never enters _available
      this._runOnEngine(engine, fen, depth).then(resolve).catch(reject);
    } else {
      // No pending work — return engine to idle pool
      this._available.push(engine);
    }
  }
}
