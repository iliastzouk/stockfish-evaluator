import express from "express";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// Optional auth middleware
function authenticate(req, res, next) {
  const apiKey = process.env.STOCKFISH_API_KEY;
  
  // If no API key is set, skip auth
  if (!apiKey) {
    return next();
  }

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

function parseScore(line) {
  const tokens = line.split(" ");
  const scoreIndex = tokens.indexOf("score");
  if (scoreIndex === -1 || scoreIndex + 2 >= tokens.length) {
    return null;
  }

  const type = tokens[scoreIndex + 1];
  const value = Number(tokens[scoreIndex + 2]);
  if (!Number.isFinite(value)) {
    return null;
  }

  if (type === "cp") {
    return { type: "cp", value };
  }

  if (type === "mate") {
    return { type: "mate", value };
  }

  return null;
}

function parseInfoLine(line) {
  // Parse: info depth N ... multipv N score (cp|mate) N ... pv move1 move2 ...
  const tokens = line.split(" ");

  const get = (key) => {
    const i = tokens.indexOf(key);
    return i !== -1 ? tokens[i + 1] : null;
  };

  const multipv  = Number(get("multipv") ?? 1);
  const scoreCp  = tokens.indexOf("cp")   !== -1 ? Number(tokens[tokens.indexOf("cp")   + 1]) : null;
  const scoreMate= tokens.indexOf("mate") !== -1 ? Number(tokens[tokens.indexOf("mate") + 1]) : null;

  // Extract PV: everything after the "pv" token
  const pvIdx = tokens.indexOf("pv");
  const pv    = pvIdx !== -1 ? tokens.slice(pvIdx + 1) : [];

  // Evaluation: white-positive centipawns, ±10000 for mate
  let evaluation = 0;
  let mate       = null;
  if (scoreMate !== null) {
    mate       = scoreMate;
    evaluation = scoreMate > 0 ? 10000 : -10000;
  } else if (scoreCp !== null) {
    evaluation = scoreCp;
  }

  return { multipv, evaluation, mate, pv, bestMove: pv[0] ?? null };
}

app.post("/evaluate", authenticate, async (req, res) => {
  const { fen, depth = 18, multipv: requestedMultiPV = 3 } = req.body || {};

  if (!fen || typeof fen !== "string") {
    return res.status(400).json({ error: "Missing FEN" });
  }

  const MULTIPV = Math.max(1, Math.min(Number(requestedMultiPV) || 3, 5));

  try {
    const sf = await import("stockfish.js");
    const engine = sf.default();

    // pvSlots[1..MULTIPV] → latest parsed info for that multipv slot
    const pvSlots   = {};
    let   bestMove  = null;
    let   responded = false;

    const timeoutId = setTimeout(() => {
      if (responded) return;
      responded = true;
      res.status(504).json({ error: "Stockfish timeout" });
    }, 20000);

    engine.addMessageListener((line) => {
      if (line.startsWith("info") && line.includes(" score ") && line.includes(" pv ")) {
        const parsed = parseInfoLine(line);
        pvSlots[parsed.multipv] = parsed;
      }

      if (line.startsWith("bestmove")) {
        bestMove = line.split(" ")[1] || null;

        if (!responded) {
          responded = true;
          clearTimeout(timeoutId);

          // Build moves array sorted by multipv slot (best first)
          const moves = Object.keys(pvSlots)
            .map(Number)
            .sort((a, b) => a - b)
            .map((slot) => pvSlots[slot]);

          // Top line is the primary evaluation
          const top = moves[0] ?? { evaluation: 0, mate: null, bestMove };

          res.json({
            bestMove:   bestMove ?? top.bestMove,
            evaluation: top.evaluation,
            mate:       top.mate,
            moves,   // [{ evaluation, mate, pv, bestMove }, ...]
          });
        }

        engine.terminate();
      }
    });

    engine.postMessage("uci");
    engine.postMessage(`setoption name MultiPV value ${MULTIPV}`);
    engine.postMessage(`position fen ${fen}`);
    engine.postMessage(`go depth ${depth}`);
  } catch (error) {
    res.status(500).json({ error: `Stockfish error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stockfish service running on port ${PORT}`);
});