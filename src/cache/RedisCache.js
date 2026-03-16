/**
 * RedisCache
 *
 * Singleton Redis client with graceful degradation.
 *
 * If REDIS_URL is not set, or if Redis becomes unavailable at any point,
 * all operations silently return null / no-op. The engine pool continues
 * working exactly as before — cache is purely additive.
 *
 * Key schema : eval:{fen}:{depth}
 * TTL        : 30 days  (eval results are deterministic for a given fen+depth)
 *
 * Metrics    : in-process hit/miss/error counters, logged every 5 minutes.
 *              Exposed via getCacheMetrics() for the /health endpoint.
 */

import { createClient } from "redis";

// ── Constants ─────────────────────────────────────────────────────────────────

const TTL_SECONDS        = 60 * 60 * 24 * 30; // 30 days
const METRICS_LOG_MS     = 5 * 60 * 1_000;    // log every 5 minutes
const MAX_RECONNECT_COUNT = 6;

// ── State ─────────────────────────────────────────────────────────────────────

let _client = null;
let _ready  = false;

const _metrics = { hits: 0, misses: 0, errors: 0, writes: 0 };
const _featureMetrics = Object.create(null); // feature -> { hits, misses }

// ── Public: Init ──────────────────────────────────────────────────────────────

/**
 * Connect to Redis. Must be called once at startup (before pool.init()).
 * Safe to call even when REDIS_URL is absent — logs a warning and returns.
 *
 * @returns {Promise<void>}
 */
export async function initRedis() {
  const url = process.env.REDIS_URL;

  if (!url) {
    console.warn(
      "[RedisCache] REDIS_URL not set — FEN cache disabled. " +
      "Engine continues normally without caching."
    );
    return;
  }

  try {
    _client = createClient({
      url,
      socket: {
        // Exponential back-off capped at 3 s; give up after 6 attempts
        // to avoid consuming CPU on a permanently-down Redis.
        reconnectStrategy: (retries) => {
          if (retries >= MAX_RECONNECT_COUNT) {
            console.error(
              `[RedisCache] ${retries} reconnect attempts failed — ` +
              "disabling cache. Engine continues without caching."
            );
            _ready = false;
            return false; // stop reconnecting
          }
          const delay = Math.min(retries * 500, 3_000);
          console.warn(`[RedisCache] Reconnecting in ${delay} ms (attempt ${retries + 1})…`);
          return delay;
        },
      },
    });

    _client.on("error", (err) => {
      if (_ready) {
        // Only log once per transition to avoid log spam
        console.error("[RedisCache] Connection lost — cache disabled until reconnect:", err.message);
      }
      _ready = false;
    });

    _client.on("ready", () => {
      _ready = true;
      console.log("[RedisCache] Connected — FEN cache active.");
    });

    await _client.connect();

    // Periodic metrics logging (fire-and-forget timer — does not block startup)
    setInterval(_logMetrics, METRICS_LOG_MS).unref();
  } catch (err) {
    console.error("[RedisCache] Initial connection failed — cache disabled:", err.message);
    _ready = false;
  }
}

// ── Public: Cache operations ──────────────────────────────────────────────────

/**
 * Look up a cached eval result.
 *
 * @param  {string} fen
 * @param  {number} depth
 * @returns {Promise<object|null>}  Parsed result or null on miss / error / cache-disabled
 */
export async function cacheGet(fen, depth, { multipv = 1, feature = null } = {}) {
  if (!_ready) return null;

  try {
    const raw = await _client.get(_key(fen, depth, multipv));
    if (raw) {
      _metrics.hits++;
      if (feature) {
        const fm = (_featureMetrics[feature] ||= { hits: 0, misses: 0 });
        fm.hits++;
      }
      return JSON.parse(raw);
    }
    _metrics.misses++;
    if (feature) {
      const fm = (_featureMetrics[feature] ||= { hits: 0, misses: 0 });
      fm.misses++;
    }
    return null;
  } catch (err) {
    _metrics.errors++;
    return null; // never propagate — engine must not fail due to cache
  }
}

/**
 * Store an eval result. Fire-and-forget — caller should not await this.
 *
 * @param  {string} fen
 * @param  {number} depth
 * @param  {object} result
 * @returns {Promise<void>}
 */
export async function cacheSet(fen, depth, result, { multipv = 1 } = {}) {
  if (!_ready) return;

  try {
    const ttl = _ttlForDepth(depth);
    await _client.set(_key(fen, depth, multipv), JSON.stringify(result), { EX: ttl });
    _metrics.writes++;
  } catch (err) {
    _metrics.errors++;
    // silence — write failure is never fatal
  }
}

// ── Public: Metrics ───────────────────────────────────────────────────────────

/**
 * Returns a snapshot of cache metrics for the /health endpoint.
 *
 * @returns {{ hits, misses, writes, errors, hitRate, ready }}
 */
export function getCacheMetrics() {
  const total = _metrics.hits + _metrics.misses;
  const perFeature = {};
  for (const [feat, m] of Object.entries(_featureMetrics)) {
    const t = m.hits + m.misses;
    perFeature[feat] = {
      hits: m.hits,
      misses: m.misses,
      hitRate: t > 0 ? `${((m.hits / t) * 100).toFixed(1)}%` : "n/a",
    };
  }
  return {
    ..._metrics,
    hitRate: total > 0 ? `${((_metrics.hits / total) * 100).toFixed(1)}%` : "n/a",
    ready:   _ready,
    perFeature,
  };
}

// ── Private ───────────────────────────────────────────────────────────────────

function _key(fen, depth, multipv) {
  return `eval:${fen}:${depth}:mpv${multipv}`;
}

function _ttlForDepth(depth) {
  const d = Number(depth) || 0;
  if (d <= 10) return 5 * 60;           // 5 min
  if (d <= 18) return 60 * 60;          // 1 hour
  return 24 * 60 * 60;                  // 24 hours
}

function _logMetrics() {
  const m = getCacheMetrics();
  console.log(
    `[RedisCache] hits=${m.hits} misses=${m.misses} ` +
    `writes=${m.writes} errors=${m.errors} hitRate=${m.hitRate}`
  );
}
