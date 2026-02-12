import express from "express";
import { Engine } from "node-uci";

const app = express();
app.use(express.json());

// Optional auth middleware
function authenticate(req, res, next) {
  const apiKey = process.env.STOCKFISH_API_KEY;
  
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

app.post("/evaluate", authenticate, async (req, res) => {
  const { fen, depth = 18 } = req.body || {};

  if (!fen || typeof fen !== "string") {
    return res.status(400).json({ error: "Missing FEN" });
  }

  let engine;
  try {
    // Use system Stockfish binary (installed via Docker or system package)
    const stockfishPath = process.env.STOCKFISH_PATH || "stockfish";
    engine = new Engine(stockfishPath);

    await engine.init();
    await engine.setoption("MultiPV", "1");
    await engine.isready();

    await engine.position(fen);
    const result = await engine.go({ depth });

    // Parse best move and evaluation
    const bestMove = result.bestmove || null;
    let evaluation = 0;
    let mate = null;

    if (result.info && result.info.length > 0) {
      const lastInfo = result.info[result.info.length - 1];
      
      if (lastInfo.score?.mate !== undefined) {
        mate = lastInfo.score.mate;
        evaluation = mate > 0 ? 10000 : -10000;
      } else if (lastInfo.score?.cp !== undefined) {
        evaluation = lastInfo.score.cp;
      }
    }

    await engine.quit();

    res.json({
      bestMove,
      evaluation,
      mate
    });
  } catch (error) {
    if (engine) {
      try {
        await engine.quit();
      } catch {}
    }
    res.status(500).json({ error: `Stockfish error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stockfish service running on port ${PORT}`);
});
