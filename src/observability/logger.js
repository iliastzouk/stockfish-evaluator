function safeError(err) {
  if (!err) return null;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { unserializable: true };
  }
}

export function log(level, event, fields = {}) {
  const ts = new Date().toISOString();
  const payload = safeJson({
    ts,
    level,
    service: "stockfish-service",
    event,
    ...fields,
    error: fields?.error instanceof Error ? safeError(fields.error) : fields?.error,
  });

  const line = JSON.stringify(payload);
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

export function logInfo(event, fields)  { return log("info",  event, fields); }
export function logWarn(event, fields)  { return log("warn",  event, fields); }
export function logError(event, fields) { return log("error", event, fields); }

