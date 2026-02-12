# Stockfish Microservice

Production-ready Stockfish evaluation service using Docker + Railway.

## 🚀 Quick Deploy to Railway

### 1️⃣ Push to GitHub

```bash
cd stockfish-service
git init
git add .
git commit -m "Stockfish microservice"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/stockfish-evaluator.git
git push -u origin main
```

### 2️⃣ Deploy on Railway

1. Sign in at [railway.app](https://railway.app) with GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Select **stockfish-evaluator**
4. Railway auto-detects **Dockerfile** → builds automatically
5. Wait 2-3 minutes for deployment

### 3️⃣ Set Environment Variables

Railway dashboard → **Variables**:
```
STOCKFISH_API_KEY=<your-secret-key>
```

Generate secure key:
```bash
openssl rand -base64 32
```

### 4️⃣ Get Service URL

Railway provides: `https://stockfish-evaluator-production.up.railway.app`

### 5️⃣ Test Endpoint

```bash
curl -X POST https://YOUR_SERVICE_URL/evaluate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"fen": "8/8/8/4K3/3P4/8/8/k7 w - - 0 1", "depth": 15}'
```

Expected:
```json
{
  "bestMove": "e5e6",
  "evaluation": 350,
  "mate": null
}
```

## Run locally (for testing)

Requires Stockfish binary installed:

```bash
# macOS
brew install stockfish

# Ubuntu/Debian
sudo apt-get install stockfish

# Run server
npm install
npm start
```


## API Reference

### POST /evaluate

Evaluate a chess position.

**Request:**
```json
{
  "fen": "8/8/8/4K3/3P4/8/8/k7 w - - 0 1",
  "depth": 18
}
```

**Response:**
```json
{
  "bestMove": "e5e6",
  "evaluation": 350,
  "mate": null
}
```

- `bestMove`: UCI notation (e.g. "e5e6")
- `evaluation`: Centipawns (positive = white winning)
- `mate`: Mate in X moves (null if no mate)

**Auth Header:**
```
Authorization: Bearer YOUR_API_KEY
```

## Configure Supabase

After Railway deployment:

```bash
# Set secrets in Supabase
supabase secrets set STOCKFISH_EVAL_URL=https://YOUR_SERVICE_URL/evaluate
supabase secrets set STOCKFISH_API_KEY=your_api_key

# Deploy edge function
cd chess-reps-clone
supabase functions deploy evaluate-endgame
```

## Architecture

```
User → Supabase Edge Function
       ├─ ≤7 pieces → Lichess Tablebase (instant, deterministic)
       └─ >7 pieces → Railway Stockfish (quality engine eval)
```

- `evaluation` is in centipawns.
- `mate` is the mate distance if present.

## Authentication

Optional Bearer token auth. Set environment variable:
```bash
STOCKFISH_API_KEY=your_secret_key
```

Then include in requests:
```bash
curl -X POST http://localhost:3000/evaluate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_secret_key" \
  -d '{"fen": "8/8/8/4K3/3P4/8/8/k7 w - - 0 1"}'
```

## Deployment

See [DEPLOY.md](DEPLOY.md) for Railway, Fly.io, Render, and VPS deployment guides.
