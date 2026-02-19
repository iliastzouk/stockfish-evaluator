/**
 * StockfishProcess
 *
 * Manages a single persistent Stockfish binary process for the lifetime of
 * the server. Replaces the previous spawn-per-request model.
 *
 * Concurrency model:
 *   - evaluate() while idle        → runs immediately
 *   - evaluate() while busy        → queued in single slot, runs when current finishes
 *   - evaluate() while busy+queued → throws "Engine busy"
 *
 * Usage:
 *   const engine = new StockfishProcess(path, { depth: 18, multiPV: 3 });
 *   await engine.init();
 *   const result = await engine.evaluate(fen, 18);
 *   await engine.quit();
 */

import { spawn } from "child_process";

const MAX_DEPTH = 20;
const INIT_TIMEOUT_MS = 10_000;
const EVAL_TIMEOUT_MS = 15_000;

export class StockfishProcess {
  /**
   * @param {string} binaryPath   Path to the Stockfish binary
   * @param {object} options
   * @param {number} options.multiPV  Number of lines to analyse (default 3)
   * @param {number} options.threads  Engine thread count (default 1)
   */
  constructor(binaryPath, options = {}) {
    this._path = binaryPath;
    this._multiPV = options.multiPV ?? 3;
    this._threads = options.threads ?? 1;

    this._proc = null;
    this._ready = false;

    // Evaluation state
    this._busy = false;
    this._pendingQueue = null;   // { fen, depth, resolve, reject }
    this._currentResolve = null;
    this._currentReject = null;
    this._evalTimeout = null;

    // Per-evaluation accumulators
    this._multipvResults = {};
    this._sideToMove = "w";

    // Stdout line buffer (data arrives in chunks)
    this._lineBuffer = "";
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Spawn the engine process, send UCI handshake, and wait until ready.
   * Must be called once before evaluate().
   */
  async init() {
    if (this._ready) return;

    this._proc = spawn(this._path);

    // Wire up stdout line dispatcher
    this._proc.stdout.on("data", (chunk) => this._onData(chunk));

    this._proc.stderr.on("data", (data) => {
      console.error("[StockfishProcess] stderr:", data.toString().trim());
    });

    this._proc.on("error", (err) => {
      console.error("[StockfishProcess] process error:", err.message);
      if (this._currentReject) {
        this._currentReject(new Error(`Engine process error: ${err.message}`));
        this._cleanupEval();
      }
    });

    this._proc.on("exit", (code, signal) => {
      console.warn(`[StockfishProcess] process exited (code=${code} signal=${signal})`);
      this._ready = false;
    });

    // Wait for uciok
    await this._sendAndWait("uci\n", "uciok", INIT_TIMEOUT_MS);

    // Set persistent options
    this._write(`setoption name MultiPV value ${this._multiPV}\n`);
    this._write(`setoption name Threads value ${this._threads}\n`);
    this._write("setoption name SyzygyProbeDepth value 0\n");

    // Wait for readyok
    await this._sendAndWait("isready\n", "readyok", INIT_TIMEOUT_MS);

    this._ready = true;
    console.log("[StockfishProcess] Engine ready.");
    // Signal handling is intentionally NOT registered here.
    // Ownership of SIGTERM/SIGINT belongs to the caller (EnginePool or server).
    // Registering process.once() per engine instance causes only the first
    // handler to fire when multiple engines are active.
  }

  /**
   * Evaluate a FEN position.
   *
   * @param {string} fen    Position in FEN notation
   * @param {number} depth  Search depth (capped at MAX_DEPTH)
   * @returns {Promise<EvalResult>}
   */
  async evaluate(fen, depth = 18) {
    if (!this._ready) throw new Error("Engine not initialized");

    if (this._busy) {
      // Queue slot already taken → hard reject
      if (this._pendingQueue) {
        throw new Error("Engine busy");
      }

      // Queue this call — it will be started when the current eval finishes
      return new Promise((resolve, reject) => {
        this._pendingQueue = { fen, depth, resolve, reject };
      });
    }

    return this._runEvaluate(fen, depth);
  }

  /**
   * Return engine status without exposing private fields directly.
   * Use this in health routes instead of reading _ready / _busy etc.
   */
  getStatus() {
    return {
      ready:   this._ready,
      busy:    this._busy,
      queued:  this._pendingQueue !== null,
    };
  }

  /**
   * Send quit and kill the process cleanly.
   */
  async quit() {
    if (!this._proc) return;

    // Cancel any queued work
    if (this._pendingQueue) {
      this._pendingQueue.reject(new Error("Engine shutting down"));
      this._pendingQueue = null;
    }

    // Cancel current eval
    if (this._currentReject) {
      this._currentReject(new Error("Engine shutting down"));
      this._cleanupEval();
    }

    this._ready = false;

    try {
      this._write("quit\n");
    } catch {}

    // Give it 1s to quit cleanly, then force-kill
    await new Promise((resolve) => {
      const kill = setTimeout(() => {
        try { this._proc.kill("SIGKILL"); } catch {}
        resolve();
      }, 1000);

      this._proc.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
    });

    this._proc = null;
    console.log("[StockfishProcess] Engine stopped.");
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  /**
   * Actually run an evaluation — must only be called when not busy.
   */
  _runEvaluate(fen, depth) {
    this._busy = true;
    this._multipvResults = {};
    this._sideToMove = fen.split(" ")[1] || "w";

    const cappedDepth = Math.min(Math.max(1, depth), MAX_DEPTH);

    return new Promise((resolve, reject) => {
      this._currentResolve = resolve;
      this._currentReject = reject;

      // Hard timeout per evaluation.
      // Guard: if bestmove already resolved this eval, abort cleanly.
      this._evalTimeout = setTimeout(() => {
        if (!this._busy) return;          // already resolved — do nothing
        this._write("stop\n");            // tell engine to stop searching
        this._lineBuffer = "";           // discard any partial line from stopped search
        reject(new Error("Stockfish timeout"));
        this._cleanupEval();
      }, EVAL_TIMEOUT_MS);

      // Reset transposition table between positions for determinism
      this._write("ucinewgame\n");
      this._write(`position fen ${fen}\n`);
      this._write(`go depth ${cappedDepth}\n`);
    });
  }

  /**
   * Reset per-evaluation state and process the pending queue if any.
   */
  _cleanupEval() {
    clearTimeout(this._evalTimeout);
    this._evalTimeout = null;
    this._currentResolve = null;
    this._currentReject = null;
    this._multipvResults = {};
    this._busy = false;

    // Drain single-slot queue.
    // Wrapped in try/catch: if _runEvaluate throws synchronously (e.g. engine
    // exited between evals), the queued caller gets a proper rejection instead
    // of an unhandled promise.
    if (this._pendingQueue) {
      const { fen, depth, resolve, reject } = this._pendingQueue;
      this._pendingQueue = null;
      try {
        this._runEvaluate(fen, depth).then(resolve).catch(reject);
      } catch (err) {
        reject(err);
      }
    }
  }

  /**
   * Write a raw UCI command string to stdin.
   */
  _write(cmd) {
    this._proc.stdin.write(cmd);
  }

  /**
   * Accumulate raw stdout chunks into complete lines and dispatch each line.
   */
  _onData(chunk) {
    this._lineBuffer += chunk.toString();
    const lines = this._lineBuffer.split("\n");

    // Keep the last (potentially incomplete) fragment in the buffer
    this._lineBuffer = lines.pop();

    for (const line of lines) {
      this._onLine(line.trim());
    }
  }

  /**
   * Process a single UCI output line.
   * Routes to init listener or eval listener depending on current state.
   */
  _onLine(line) {
    if (!line) return;

    // Forward to one-shot init listener if active
    if (this._initLineHandler) {
      this._initLineHandler(line);
      return;
    }

    // ── Evaluation output ─────────────────────────────────────────────────────

    // info ... multipv N ... score ... pv ...
    if (line.startsWith("info") && line.includes(" multipv ")) {
      this._parseInfoLine(line);
      return;
    }

    // bestmove → evaluation complete.
    // Guard: if timeout already rejected this eval, abort cleanly.
    if (line.startsWith("bestmove")) {
      if (!this._busy) return;            // timeout already fired — do nothing
      const result = this._buildResult();
      const resolve = this._currentResolve;
      this._cleanupEval();
      resolve?.(result);
    }
  }

  /**
   * Parse an `info` line and accumulate into multipvResults.
   * Keeps the exact same logic as the original runStockfish().
   */
  _parseInfoLine(line) {
    const multipvMatch = line.match(/ multipv (\d+)/);
    if (!multipvMatch) return;

    const multipvNum = parseInt(multipvMatch[1], 10);
    const pvMatch = line.match(/ pv ((?:[a-h][1-8][a-h][1-8][qrbn]? ?)+)/);
    const pvArr = pvMatch ? pvMatch[1].trim().split(/\s+/) : [];
    const move = pvArr[0] || null;

    let evaluation = null;
    let mate = null;

    const mateMatch = line.match(/score mate (-?\d+)/);
    const cpMatch = line.match(/score cp (-?\d+)/);

    if (mateMatch) {
      const rawMate = parseInt(mateMatch[1], 10);
      mate = this._sideToMove === "b" ? -rawMate : rawMate;
      evaluation = mate > 0 ? 10000 : -10000;
    } else if (cpMatch) {
      const rawEval = parseInt(cpMatch[1], 10);
      evaluation = this._sideToMove === "b" ? -rawEval : rawEval;
    }

    if (move && evaluation !== null) {
      this._multipvResults[multipvNum] = { move, evaluation, mate, pv: pvArr };
    }
  }

  /**
   * Build the final result object from accumulated multipv data.
   * Keeps the exact same sort logic as the original runStockfish().
   */
  _buildResult() {
    const moves = Object.keys(this._multipvResults)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => this._multipvResults[n])
      .filter((m) => m && m.move && m.evaluation !== null)
      .sort((a, b) => {
        if (a.mate !== null && b.mate !== null) {
          if (a.mate > 0 && b.mate > 0) return a.mate - b.mate;
          if (a.mate < 0 && b.mate < 0) return b.mate - a.mate;
          if (a.mate > 0) return -1;
          if (b.mate > 0) return 1;
        }
        if (a.mate !== null) return a.mate > 0 ? -1 : 1;
        if (b.mate !== null) return b.mate > 0 ? 1 : -1;
        return b.evaluation - a.evaluation;
      });

    const primary = moves[0] || null;

    return {
      bestMove: primary?.move ?? null,
      evaluation: primary?.evaluation ?? null,
      mate: primary?.mate ?? null,
      moves,
    };
  }

  /**
   * Send a command and resolve when a specific response token appears.
   * Used only during init handshake.
   */
  _sendAndWait(command, expectedToken, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._initLineHandler = null;
        reject(new Error(`Timeout waiting for "${expectedToken}"`));
      }, timeoutMs);

      this._initLineHandler = (line) => {
        if (line.startsWith(expectedToken)) {
          clearTimeout(timer);
          this._initLineHandler = null;
          resolve();
        }
      };

      this._write(command);
    });
  }
}
