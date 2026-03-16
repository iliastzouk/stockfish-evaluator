import crypto from "crypto";
import { logInfo, logError } from "./logger.js";

function pickHeader(req, name) {
  const v = req.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function resolveIds(req) {
  const correlationId =
    pickHeader(req, "x-correlation-id") ||
    pickHeader(req, "x-request-id") ||
    pickHeader(req, "x-amzn-trace-id") ||
    null;

  const requestId =
    pickHeader(req, "x-request-id") ||
    crypto.randomUUID();

  return {
    correlationId: correlationId || requestId,
    requestId,
  };
}

function featureFromPath(path) {
  if (typeof path !== "string") return "unknown";
  if (path.startsWith("/evaluate")) return "evaluation";
  if (path.startsWith("/health") || path.startsWith("/recover")) return "evaluation";
  return "unknown";
}

export function requestContextMiddleware() {
  return (req, res, next) => {
    const { correlationId, requestId } = resolveIds(req);
    const feature = featureFromPath(req.originalUrl || req.url || "");

    req.correlationId = correlationId;
    req.requestId = requestId;
    req.feature = feature;
    req._requestStartNs = process.hrtime.bigint();

    res.setHeader("x-request-id", requestId);
    res.setHeader("x-correlation-id", correlationId);

    res.on("finish", () => {
      const end = process.hrtime.bigint();
      const latencyMs = Number(end - req._requestStartNs) / 1e6;
      logInfo("http_request", {
        correlationId,
        requestId,
        feature,
        method: req.method,
        path: req.originalUrl || req.url,
        statusCode: res.statusCode,
        latencyMs: Math.round(latencyMs),
      });
    });

    next();
  };
}

export function errorLoggingMiddleware() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const correlationId = req?.correlationId || null;
    const requestId = req?.requestId || null;
    const feature = req?.feature || "unknown";
    const start = req?._requestStartNs;
    const latencyMs = start ? Number(process.hrtime.bigint() - start) / 1e6 : null;

    logError("http_error", {
      correlationId,
      requestId,
      feature,
      method: req?.method,
      path: req?.originalUrl || req?.url,
      statusCode: res?.statusCode ?? 500,
      latencyMs: latencyMs != null ? Math.round(latencyMs) : null,
      error: err,
    });

    if (res.headersSent) return;
    res.status(500).json({ error: err?.message || "Internal server error" });
  };
}

