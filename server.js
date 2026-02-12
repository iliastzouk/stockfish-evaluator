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

app.post("/evaluate", authenticate, async (req, res) => {
  const { fen, depth = 18 } = req.body || {};

  if (!fen || typeof fen !== "string") {
    return res.status(400).json({ error: "Missing FEN" });
  }

  try {
    // Dynamic import of stockfish.js (WASM version works in Node 18+)
    const sf = await import("stockfish.js");
    const engine = sf.default();
    
    let bestMove = null;
    let scoreCp = null;
    let mateIn = null;
    let responded = false;

    const timeoutId = setTimeout(() => {
      if (responded) return;
      responded = true;
      res.status(504).json({ error: "Stockfish timeout" });
    }, 15000);

    engine.addMessageListener((line) => {
      if (line.startsWith("info") && line.includes(" score ")) {
        const parsed = parseScore(line);
        if (parsed?.type === "cp") {
          scoreCp = parsed.value;
        }
        if (parsed?.type === "mate") {
          mateIn = parsed.value;
        }
      }

      if (line.startsWith("bestmove")) {
        bestMove = line.split(" ")[1] || null;

        if (!responded) {
          responded = true;
          clearTimeout(timeoutId);
          res.json({
            bestMove,
            evaluation: mateIn !== null ? (mateIn > 0 ? 10000 : -10000) : (scoreCp || 0),
            mate: mateIn
          });
        }

        engine.terminate();
      }
    });

    engine.postMessage("uci");
    engine.postMessage("setoption name MultiPV value 1");
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