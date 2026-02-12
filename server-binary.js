import express from "express";
import { spawn } from "child_process";

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

function runStockfish(fen, depth) {
  return new Promise((resolve, reject) => {
    const stockfishPath = process.env.STOCKFISH_PATH || "stockfish";
    const stockfish = spawn(stockfishPath);

    let bestMove = null;
    let evaluation = 0;
    let mate = null;
    let timeout;

    const cleanup = () => {
      clearTimeout(timeout);
      try {
        stockfish.kill();
      } catch {}
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Stockfish timeout"));
    }, 15000);

    stockfish.stdout.on("data", (data) => {
      const output = data.toString();
      const lines = output.split("\n");

      for (const line of lines) {
        // Parse score from info lines
        if (line.startsWith("info") && line.includes(" score ")) {
          const cpMatch = line.match(/score cp (-?\d+)/);
          const mateMatch = line.match(/score mate (-?\d+)/);

          if (mateMatch) {
            mate = parseInt(mateMatch[1], 10);
            evaluation = mate > 0 ? 10000 : -10000;
          } else if (cpMatch) {
            evaluation = parseInt(cpMatch[1], 10);
          }
        }

        // Parse best move
        if (line.startsWith("bestmove")) {
          const match = line.match(/^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
          if (match) {
            bestMove = match[1];
          }
          cleanup();
          resolve({ bestMove, evaluation, mate });
          return;
        }
      }
    });

    stockfish.stderr.on("data", (data) => {
      console.error(`Stockfish error: ${data}`);
    });

    stockfish.on("error", (error) => {
      cleanup();
      reject(error);
    });

    // Send UCI commands
    stockfish.stdin.write("uci\n");
    stockfish.stdin.write("isready\n");
    stockfish.stdin.write(`position fen ${fen}\n`);
    stockfish.stdin.write(`go depth ${depth}\n`);
  });
}

app.post("/evaluate", authenticate, async (req, res) => {
  const { fen, depth = 18 } = req.body || {};

  if (!fen || typeof fen !== "string") {
    return res.status(400).json({ error: "Missing FEN" });
  }

  try {
    const result = await runStockfish(fen, depth);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Stockfish error: ${error.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stockfish service running on port ${PORT}`);
});
