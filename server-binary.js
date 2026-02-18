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

function runStockfish(fen, depth) {
  return new Promise((resolve, reject) => {
    const stockfishPath = process.env.STOCKFISH_PATH || "stockfish";
    const stockfish = spawn(stockfishPath);

    let multipvResults = {};
    let timeout;

    const fenFields = fen.split(" ");
    const sideToMove = fenFields[1]; // "w" or "b"

    const cleanup = () => {
      clearTimeout(timeout);
      try { stockfish.kill(); } catch {}
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Stockfish timeout"));
    }, 15000);

    stockfish.stdout.on("data", (data) => {
      const lines = data.toString().split("\n");

      for (const line of lines) {

        // Parse multipv lines
        if (line.startsWith("info") && line.includes(" multipv ")) {
          const multipvMatch = line.match(/ multipv (\d+)/);
          if (!multipvMatch) continue;

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

            // Normalize mate to White perspective
            mate = sideToMove === "b" ? -rawMate : rawMate;

            evaluation = mate > 0 ? 10000 : -10000;
          }
          else if (cpMatch) {
            let rawEval = parseInt(cpMatch[1], 10);

            // Normalize to White perspective
            evaluation = sideToMove === "b" ? -rawEval : rawEval;
          }

          if (move && evaluation !== null) {
            multipvResults[multipvNum] = {
              move,
              evaluation,
              mate,
              pv: pvArr
            };
          }
        }

        // Parse bestmove → finish evaluation
        if (line.startsWith("bestmove")) {

          const moves = Object.keys(multipvResults)
            .map(Number)
            .sort((a, b) => a - b)
            .map((n) => multipvResults[n])
            .filter(m => m && m.move && m.evaluation !== null)
            .sort((a, b) => {

              // Mate priority
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

          cleanup();

          const bestMove = moves[0]?.move || null;
          const primary = moves[0] || null;

          resolve({
            bestMove,
            evaluation: primary?.evaluation ?? null,
            mate: primary?.mate ?? null,
            moves
          });

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

    // UCI flow
    stockfish.stdin.write("uci\n");
    stockfish.stdin.write("isready\n");
    stockfish.stdin.write("setoption name MultiPV value 3\n");
    stockfish.stdin.write("ucinewgame\n");
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
