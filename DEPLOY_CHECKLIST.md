# 🚀 Railway Deployment Checklist

## ✅ Pre-Deployment (Done)

- [x] Dockerfile created (Node 18 Alpine + Stockfish binary)
- [x] server-binary.js uses child_process spawn  
- [x] package.json configured with start script
- [x] .gitignore added  
- [x] README.md with deployment guide
- [x] Auth middleware implemented

## 📦 Files Ready

```
stockfish-service/
├── Dockerfile           ← Railway builds from this
├── server-binary.js     ← Main server
├── package.json         ← Dependencies (express only)
├── .gitignore
├── README.md
└── DEPLOY_CHECKLIST.md  ← This file
```

## 🔧 Step-by-Step Deployment

### 1️⃣ Push to GitHub

```bash
cd c:\chess\stockfish-service
git init
git add .
git commit -m "Stockfish microservice with Docker"
git branch -M main
```

Create repo at: https://github.com/new (name: `stockfish-evaluator`)

```bash
git remote add origin https://github.com/YOUR_USERNAME/stockfish-evaluator.git
git push -u origin main
```

### 2️⃣ Deploy on Railway

1. https://railway.app → Sign in with GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Select **stockfish-evaluator**
4. Railway auto-detects Dockerfile → builds (2-3 min)

### 3️⃣ Set Environment Variable

Railway dashboard → Your service → **Variables**:

```
STOCKFISH_API_KEY=<your-secret>
```

Generate key:
```bash
openssl rand -base64 32
```

**⚠️ Save this key!** You'll need it for Supabase.

### 4️⃣ Get Service URL  

Railway provides URL like:
```
https://stockfish-evaluator-production.up.railway.app
```

**⚠️ Copy this URL!** You'll need it for Supabase.

### 5️⃣ Test Deployment

```bash
curl -X POST https://YOUR_RAILWAY_URL/evaluate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"fen": "8/8/8/4K3/3P4/8/8/k7 w - - 0 1", "depth": 15}'
```

Expected:
```json
{"bestMove": "e5e6", "evaluation": 350, "mate": null}
```

## 🔗 Configure Supabase

### Set Secrets

```bash
cd c:\chess\chess-reps-clone

supabase secrets set STOCKFISH_EVAL_URL=https://YOUR_RAILWAY_URL/evaluate
supabase secrets set STOCKFISH_API_KEY=your_api_key_from_step_3
```

### Deploy Edge Function

```bash
supabase functions deploy evaluate-endgame
```

### Test Hybrid Evaluator

```bash
# ≤7 pieces → Lichess tablebase
supabase functions invoke evaluate-endgame \
  --body '{"fen": "8/8/8/4K3/3P4/8/8/k7 w - - 0 1"}'

# >7 pieces → Railway Stockfish
supabase functions invoke evaluate-endgame \
  --body '{"fen": "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"}'
```

## ✅ Final Verification

- [ ] Railway service deployed & running
- [ ] `STOCKFISH_API_KEY` set in Railway
- [ ] Service URL copied
- [ ] Direct curl to Railway works
- [ ] Supabase secrets configured
- [ ] Edge function deployed
- [ ] Tablebase works (≤7 pieces)
- [ ] Stockfish works (>7 pieces)

## 🐛 Troubleshooting

**Railway build fails:**
- Check logs in Railway dashboard
- Verify Node 18+ in Dockerfile

**Service returns 500:**
```
Error: spawn stockfish ENOENT
```
→ Stockfish binary not found. Check Dockerfile installs it.

**Edge function can't reach Stockfish:**
- Test Railway service directly first
- Verify `STOCKFISH_EVAL_URL` in Supabase secrets
- Check Railway service is running (not sleeping)

**Auth fails:**
- Verify `Authorization: Bearer YOUR_KEY` format
- Check same key in Railway + Supabase
- Redeploy secrets: `supabase secrets set ...`

## 🎯 Next Steps

After deployment:

1. **Update Practice Generators** - use hybrid evaluator instead of random positions
2. **Add Opposition Practice** - with engine verification  
3. **Monitor Railway** - set up error alerts
4. **Consider caching** - for frequent positions

## 💰 Railway Pricing

- **Free tier**: 500 hours/month (sleeps after inactivity)
- **Hobby plan**: $5/month (always-on)
- **Pro plan**: $20/month (more resources)

For chess endgame eval, **Hobby ($5)** is sufficient.
