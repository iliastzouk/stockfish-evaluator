import "dotenv/config";
import express from "express";
import { EnginePool } from "./src/engine/EnginePool.js";
import { initRedis, getCacheMetrics } from "./src/cache/RedisCache.js";
import { requestContextMiddleware, errorLoggingMiddleware } from "./src/observability/httpLogging.js";
import { logInfo, logError } from "./src/observability/logger.js";

// Lightweight FEN validator — no external dependency needed.
// Catches malformed strings that would crash the engine internally.
// Structure: 8 ranks / side-to-move / castling / en-passant / half / full
const FEN_RE =
  /^([1-8prnbqkPRNBQK]+\/){7}[1-8prnbqkPRNBQK]+\s[bw]\s(-|[KQkq]{1,4})\s(-|[a-h][36])\s\d+\s\d+$/;

function isValidFen(fen) {
  return typeof fen === "string" && FEN_RE.test(fen.trim());
}

// ── Config ────────────────────────────────────────────────────────────────────
const ENGINE_DEPTH     = process.env.ENGINE_DEPTH     ? parseInt(process.env.ENGINE_DEPTH,     10) : 18;
const ENGINE_MULTIPV   = process.env.ENGINE_MULTIPV   ? parseInt(process.env.ENGINE_MULTIPV,   10) : 3;
const ENGINE_POOL_SIZE = process.env.ENGINE_POOL_SIZE ? parseInt(process.env.ENGINE_POOL_SIZE, 10) : 2;
const stockfishPath    = process.env.STOCKFISH_PATH   || "stockfish";
const PORT             = process.env.PORT             || 3000;

console.log("[Startup] Stockfish binary path:", stockfishPath);
console.log("[Startup] Engine depth:         ", ENGINE_DEPTH);
console.log("[Startup] MultiPV:              ", ENGINE_MULTIPV);
console.log("[Startup] Pool size:            ", ENGINE_POOL_SIZE);
console.log("[Startup] Node version:         ", process.version);

// ── Engine pool (all instances spawned ONCE at startup) ────────────────────
const pool = new EnginePool({
  binaryPath: stockfishPath,
  size:       ENGINE_POOL_SIZE,
  multiPV:    ENGINE_MULTIPV,
  threads:    1,      // keep 1 per engine on Railway Hobby — never oversubscribe CPU
  maxQueue:   10,
});

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(requestContextMiddleware());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin",  process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function authenticate(req, res, next) {
  const apiKey = process.env.STOCKFISH_API_KEY;
  if (!apiKey) return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const token = authHeader.substring(7);
  if (token !== apiKey) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post("/evaluate", authenticate, async (req, res) => {
  const { fen, depth = ENGINE_DEPTH } = req.body || {};

  if (!fen) {
    return res.status(400).json({ error: "Missing FEN" });
  }

  if (!isValidFen(fen)) {
    return res.status(400).json({ error: "Invalid FEN" });
  }

  // Cap depth at route level — callers cannot force depth > 20
  const cappedDepth = Math.min(Math.max(1, depth), 20);

  try {
    const result = await pool.evaluate(fen, cappedDepth);
    res.json(result);
  } catch (error) {
    logError("http_evaluate_failed", {
      correlationId: req.correlationId,
      requestId: req.requestId,
      feature: req.feature,
      depth: cappedDepth,
      error,
    });
    if (error.message === "Engine overloaded") {
      return res.status(503).json({ error: "Engine overloaded. Retry shortly." });
    }
    if (error.message === "No engines available") {
      return res.status(503).json({ error: "No engines available — respawn may be in progress. Retry shortly." });
    }
    if (error.message.startsWith("Engine crashed")) {
      return res.status(503).json({ error: error.message + " Retry shortly." });
    }
    res.status(500).json({ error: "Stockfish error: " + error.message });
  }
});

// POST /recover — manually trigger engine respawn when all engines have crashed.
// Protected by auth. Safe to call multiple times; _respawnEngine is idempotent.
app.post("/recover", authenticate, async (req, res) => {
  const status = pool.getStatus();
  if (status.totalEngines > 0) {
    return res.json({ message: "Pool is healthy — no recovery needed.", status });
  }
  if (status.respawning > 0) {
    return res.json({ message: "Respawn already in progress.", status });
  }
  // Trigger up to ENGINE_POOL_SIZE respawns
  pool.forceRespawn(ENGINE_POOL_SIZE);
  res.json({ message: `Triggered ${ENGINE_POOL_SIZE} engine respawn(s).`, status: pool.getStatus() });
});

app.get("/health", (req, res) => {
  res.json({
    status:  "ok",
    engine:  pool.getStatus(),
    cache:   getCacheMetrics(),
  });
});

// More detailed status for admin dashboards
app.get("/status", (req, res) => {
  const engine = pool.getStatus();
  const cache = getCacheMetrics();
  res.json({
    status: "ok",
    engine: {
      poolSize: engine.totalEngines,
      busyEngines: engine.busyEngines,
      queuedRequests: engine.queueLength,
      respawning: engine.respawning,
    },
    cache: {
      hits: cache.hits,
      misses: cache.misses,
      writes: cache.writes,
      errors: cache.errors,
      hitRate: cache.hitRate,
      ready: cache.ready,
      perFeature: cache.perFeature,
    },
    recentErrors: [], // placeholder for future in-memory error buffer
  });
});

app.use(errorLoggingMiddleware());

// ── Boot: Redis → engine pool → HTTP ────────────────────────────────────────────
// Redis init is non-fatal: if it fails, the service starts without caching.
// Engine pool init IS fatal: if Stockfish can't start, abort immediately.
initRedis()
  .then(() => pool.init())
  .then(() => {
    app.listen(PORT, () => {
      logInfo("http_server_started", { feature: "evaluation", port: PORT });
    });
  })
  .catch((err) => {
    logError("startup_engine_pool_failed", { feature: "evaluation", error: err });
    process.exit(1);
  });
