const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_VOTRE_CLE');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'VOTRE_CLE' });

// ── MONGODB ──
const MONGO_URI = process.env.MONGO_URI || '';
let db = null;

async function connectDB() {
  if (!MONGO_URI) { console.log('⚠️  MongoDB non configuré'); return; }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('viralboost');
    console.log('✅ MongoDB connecté');
  } catch(e) { console.error('❌ MongoDB erreur:', e.message); }
}
connectDB();

// ── ROUTE PRINCIPALE ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── ENREGISTRER UTILISATEUR ──
app.post('/api/register-user', async (req, res) => {
  try {
    if (!db) return res.json({ ok: false, reason: 'no_db' });
    const { name, email, plan, createdAt, projectsCount } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    await db.collection('users').updateOne(
      { email },
      { $set: { name, email, plan, projectsCount, updatedAt: new Date() },
        $setOnInsert: { createdAt: createdAt || new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN DASHBOARD ──
app.get('/admin', async (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== (process.env.ADMIN_KEY || 'viralboost-admin')) {
    return res.status(403).send('❌ Accès refusé');
  }
  if (!db) return res.send('⚠️ MongoDB non configuré. Ajoute MONGO_URI dans les variables Render.');
  try {
    const users = await db.collection('users').find({}).sort({ createdAt: -1 }).toArray();
    const total = users.length;
    const plans = { free: 0, starter: 0, elite: 0 };
    users.forEach(u => { if(plans[u.plan] !== undefined) plans[u.plan]++; });

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>ViralBoost Admin</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#05030e;color:#f5f0ff;padding:32px;max-width:1000px;margin:0 auto;}
      h1{background:linear-gradient(135deg,#9d5cff,#e879f9);-webkit-background-clip:text;-webkit-text-fill-color:transparent;font-size:28px;}
      .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:24px 0;}
      .stat{background:#0d0920;border:1px solid rgba(124,58,237,0.3);border-radius:12px;padding:20px;text-align:center;}
      .stat-num{font-size:32px;font-weight:800;color:#9d5cff;}
      .stat-label{font-size:12px;color:#6b5b8a;margin-top:4px;}
      table{width:100%;border-collapse:collapse;margin-top:24px;}
      th{background:#0d0920;padding:12px 16px;text-align:left;font-size:12px;color:#6b5b8a;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid rgba(124,58,237,0.2);}
      td{padding:12px 16px;border-bottom:1px solid rgba(124,58,237,0.08);font-size:14px;}
      tr:hover td{background:rgba(124,58,237,0.05);}
      .badge{padding:2px 10px;border-radius:100px;font-size:11px;font-weight:700;}
      .free{background:rgba(107,91,138,0.2);color:#6b5b8a;}
      .starter{background:rgba(124,58,237,0.2);color:#9d5cff;}
      .elite{background:rgba(232,121,249,0.2);color:#e879f9;}
    </style></head><body>
    <h1>⚡ ViralBoost — Admin</h1>
    <div class="stats">
      <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total inscrits</div></div>
      <div class="stat"><div class="stat-num">${plans.free}</div><div class="stat-label">Plan Free</div></div>
      <div class="stat"><div class="stat-num">${plans.starter}</div><div class="stat-label">Plan Starter 💰</div></div>
      <div class="stat"><div class="stat-num">${plans.elite}</div><div class="stat-label">Plan Elite 🔥</div></div>
    </div>
    <table>
      <tr><th>Nom</th><th>Email</th><th>Plan</th><th>Projets</th><th>Inscrit le</th></tr>
      ${users.map(u=>`
        <tr>
          <td>${u.name||'—'}</td>
          <td>${u.email}</td>
          <td><span class="badge ${u.plan||'free'}">${(u.plan||'free').toUpperCase()}</span></td>
          <td>${u.projectsCount||0}</td>
          <td>${u.createdAt?new Date(u.createdAt).toLocaleDateString('fr-FR'):'—'}</td>
        </tr>`).join('')}
    </table>
    </body></html>`;
    res.send(html);
  } catch(err) { res.status(500).send('Erreur: ' + err.message); }
});

// ── PAYMENT ──
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const pi = await stripe.paymentIntents.create({
      amount: req.body.amount, currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { service: 'viralboost' }
    });
    res.json({ clientSecret: pi.client_secret });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GENERATE BOOST ──
app.post('/api/generate-boost', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: req.body.prompt }]
    });
    res.json({ content: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── COACH ──
app.post('/api/chat-promo', async (req, res) => {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      system: `Tu es un expert en marketing digital, growth hacking et promotion de projets en ligne. Tu as aidé des centaines de créateurs, startups et entrepreneurs à faire décoller leur visibilité. Tu donnes des conseils CONCRETS, ACTIONNABLES et PERSONNALISÉS sur : TikTok, Instagram, SEO, publicités Facebook/Google, email marketing, stratégie de contenu. Tu réponds en français avec enthousiasme et précision.`,
      messages: req.body.messages.slice(-10)
    });
    res.json({ reply: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── FALLBACK ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ViralBoost sur http://localhost:${PORT}`));
