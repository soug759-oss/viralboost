const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const path = require('path');
const { MongoClient } = require('mongodb');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_VOTRE_CLE');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'VOTRE_CLE' });

// ── PLANS (4 plans alignés avec le front) ──
const PLANS = {
  free:    { name: 'FREE',    price: 0,    limits: { pubsPerHour: 1, chatMsgs: 3,   vitrineHours: 1       } },
  starter: { name: 'STARTER', price: 300,  limits: { pubsPerDay: 3,  chatMsgs: 10,  vitrineHours: 168     } },
  pro:     { name: 'PRO',     price: 1499, limits: { pubsPerDay: 999, chatMsgs: 999, vitrineHours: 720     } },
  elite:   { name: 'ELITE',   price: 3999, limits: { pubsPerDay: 999, chatMsgs: 999, vitrineHours: 9999999 } },
};

// ── MONGODB ──
const MONGO_URI = process.env.MONGO_URI || '';
let db = null;

async function connectDB() {
  if (!MONGO_URI) { console.log('⚠️  MongoDB non configuré — mode mémoire actif'); return; }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('viralboost');
    console.log('✅ MongoDB connecté');

    // ── Charger l'historique chat depuis MongoDB au démarrage ──
    const savedMessages = await db.collection('chat_messages')
      .find({}).sort({ timestamp: -1 }).limit(200).toArray();
    savedMessages.reverse().forEach(m => publicMessages.push(m));
    console.log(`💬 ${publicMessages.length} messages chat chargés depuis MongoDB`);

  } catch(e) { console.error('❌ MongoDB erreur:', e.message); }
}
connectDB();

// ── IN-MEMORY FALLBACK ──
const inMemoryUsers = new Map();     // email -> user object
const inMemoryProjects = [];         // projets vitrine
const inMemoryVotes = new Map();     // projectId -> Set<userId>

// ── WEBSOCKET — CHAT EN DIRECT + DMs ──
const userSockets = new Map();
const publicMessages = [];
const dmThreads = new Map();
const onlineUsers = new Map();

function broadcastToAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function sendToUser(userId, data) {
  const sockets = userSockets.get(userId);
  if (!sockets) return;
  const msg = JSON.stringify(data);
  sockets.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function getDMKey(a, b) { return [a, b].sort().join(':'); }

wss.on('connection', (ws) => {
  let connectedUserId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch(e) { return; }

    switch(data.type) {

      case 'join': {
        connectedUserId = data.userId;
        if (!userSockets.has(data.userId)) userSockets.set(data.userId, new Set());
        userSockets.get(data.userId).add(ws);
        onlineUsers.set(data.userId, {
          id: data.userId,
          name: data.name || 'Anonyme',
          plan: data.plan || 'free',
          avatar: data.avatar || '👤'
        });
        // Envoyer l'historique des messages
        ws.send(JSON.stringify({ type: 'history', messages: publicMessages.slice(-50) }));
        // Envoyer les projets/publications existants au nouvel arrivant
        (async () => {
          try {
            let projects = [];
            if (db) {
              projects = await db.collection('projects').find({}).sort({ votes: -1, createdAt: -1 }).limit(50).toArray();
            } else {
              projects = [...inMemoryProjects].sort((a, b) => b.votes - a.votes);
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'projects_history', projects }));
            }
          } catch(e) { console.error('Erreur chargement projets:', e.message); }
        })();
        broadcastToAll({ type: 'online_users', users: Array.from(onlineUsers.values()) });
        broadcastToAll({ type: 'user_joined', user: onlineUsers.get(data.userId) });
        break;
      }

      case 'message': {
        if (!connectedUserId) return;
        const msg = {
          id: Date.now() + Math.random(),
          userId: connectedUserId,
          name: data.name || 'Anonyme',
          plan: data.plan || 'free',
          text: (data.text || '').slice(0, 500),
          timestamp: new Date().toISOString(),
          avatar: data.avatar || '👤'
        };
        publicMessages.push(msg);
        if (publicMessages.length > 200) publicMessages.shift();
        if (db) db.collection('chat_messages').insertOne({...msg}).catch(()=>{});
        broadcastToAll({ type: 'message', message: msg });
        break;
      }

      case 'dm': {
        if (!connectedUserId) return;
        const toId = data.toId;
        if (!toId || toId === connectedUserId) return;
        const dmMsg = {
          id: Date.now() + Math.random(),
          fromId: connectedUserId,
          fromName: data.fromName || 'Anonyme',
          fromPlan: data.fromPlan || 'free',
          toId,
          text: (data.text || '').slice(0, 500),
          timestamp: new Date().toISOString(),
          read: false
        };
        const key = getDMKey(connectedUserId, toId);
        if (!dmThreads.has(key)) dmThreads.set(key, []);
        dmThreads.get(key).push(dmMsg);
        if (db) db.collection('dm_messages').insertOne({...dmMsg}).catch(()=>{});
        sendToUser(toId, { type: 'dm', message: dmMsg });
        sendToUser(connectedUserId, { type: 'dm_sent', message: dmMsg });
        break;
      }

      case 'get_dm_history': {
        if (!connectedUserId) return;
        const key = getDMKey(connectedUserId, data.withId);
        ws.send(JSON.stringify({ type: 'dm_history', withId: data.withId, messages: dmThreads.get(key) || [] }));
        break;
      }

      case 'typing': {
        if (!connectedUserId) return;
        broadcastToAll({ type: 'typing', userId: connectedUserId, name: data.name, isTyping: data.isTyping });
        break;
      }

      case 'dm_typing': {
        if (!connectedUserId) return;
        sendToUser(data.toId, { type: 'dm_typing', userId: connectedUserId, name: data.name, isTyping: data.isTyping });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (connectedUserId) {
      const sockets = userSockets.get(connectedUserId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          userSockets.delete(connectedUserId);
          onlineUsers.delete(connectedUserId);
          broadcastToAll({ type: 'user_left', userId: connectedUserId });
          broadcastToAll({ type: 'online_users', users: Array.from(onlineUsers.values()) });
        }
      }
    }
  });
});

// ── ROUTE PRINCIPALE ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── ENREGISTRER / METTRE À JOUR UTILISATEUR ──
app.post('/api/register-user', async (req, res) => {
  try {
    const { name, email, plan, createdAt, projectsCount, username, avatar } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const userObj = { name, email, username, plan: plan || 'free', avatar, projectsCount: projectsCount || 0, updatedAt: new Date() };

    if (db) {
      await db.collection('users').updateOne(
        { email },
        { $set: userObj, $setOnInsert: { createdAt: createdAt || new Date() } },
        { upsert: true }
      );
    } else {
      const existing = inMemoryUsers.get(email) || {};
      inMemoryUsers.set(email, { ...existing, ...userObj, createdAt: existing.createdAt || new Date() });
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── RÉCUPÉRER UTILISATEUR ──
app.get('/api/user/:email', async (req, res) => {
  try {
    let user = null;
    if (db) {
      user = await db.collection('users').findOne({ email: req.params.email });
    } else {
      user = inMemoryUsers.get(req.params.email) || null;
    }
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json(user);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PROJETS VITRINE — LISTER ──
app.get('/api/projects', async (req, res) => {
  try {
    let projects = [];
    if (db) {
      projects = await db.collection('projects').find({}).sort({ votes: -1, createdAt: -1 }).limit(50).toArray();
    } else {
      projects = [...inMemoryProjects].sort((a, b) => b.votes - a.votes);
    }
    res.json(projects);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PROJETS VITRINE — PUBLIER ──
app.post('/api/projects', async (req, res) => {
  try {
    const proj = {
      ...req.body,
      votes: 0,
      views: 0,
      createdAt: new Date(),
      id: req.body.id || ('proj_' + Date.now())
    };
    if (db) {
      await db.collection('projects').insertOne(proj);
    } else {
      inMemoryProjects.unshift(proj);
      if (inMemoryProjects.length > 200) inMemoryProjects.pop();
    }
    // Broadcaster le nouveau projet à tous les users connectés
    broadcastToAll({ type: 'new_project', project: proj });
    res.json({ ok: true, project: proj });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PROJETS VITRINE — VOTER ──
app.post('/api/projects/:id/vote', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId requis' });

    // Vérifier doublon de vote
    if (!inMemoryVotes.has(id)) inMemoryVotes.set(id, new Set());
    if (inMemoryVotes.get(id).has(userId)) {
      return res.json({ ok: false, reason: 'already_voted' });
    }
    inMemoryVotes.get(id).add(userId);

    let newVotes = 0;
    if (db) {
      const result = await db.collection('projects').findOneAndUpdate(
        { id },
        { $inc: { votes: 1 } },
        { returnDocument: 'after' }
      );
      newVotes = result?.votes || 1;
    } else {
      const proj = inMemoryProjects.find(p => p.id === id);
      if (proj) { proj.votes = (proj.votes || 0) + 1; newVotes = proj.votes; }
    }

    // Broadcaster le nouveau compteur de votes
    broadcastToAll({ type: 'vote_update', projectId: id, votes: newVotes });
    res.json({ ok: true, votes: newVotes });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PAYMENT — CRÉER INTENT ──
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { plan } = req.body;
    const planData = PLANS[plan];
    if (!planData || planData.price === 0) {
      return res.status(400).json({ error: 'Plan invalide ou gratuit' });
    }
    const pi = await stripe.paymentIntents.create({
      amount: planData.price,
      currency: 'eur',
      automatic_payment_methods: { enabled: true },
      metadata: { service: 'viralboost', plan }
    });
    res.json({ clientSecret: pi.client_secret });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── WEBHOOK STRIPE (optionnel) ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) return res.json({ received: true });
  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const { plan } = pi.metadata;
      console.log(`✅ Paiement réussi — plan: ${plan}`);
    }
    res.json({ received: true });
  } catch(err) { res.status(400).send(`Webhook Error: ${err.message}`); }
});

// ── GENERATE BOOST (IA) ──
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

// ── COACH IA ──
app.post('/api/chat-promo', async (req, res) => {
  try {
    const lang = req.body.lang || 'fr';
    const systemPrompts = {
      fr: `Tu es un expert en marketing digital, growth hacking et promotion de projets en ligne. Tu donnes des conseils CONCRETS, ACTIONNABLES et PERSONNALISÉS sur : TikTok, Instagram, SEO, publicités Facebook/Google, email marketing, stratégie de contenu. Tu réponds en français avec enthousiasme et précision.`,
      en: `You are an expert in digital marketing, growth hacking and online project promotion. You give CONCRETE, ACTIONABLE and PERSONALIZED advice on: TikTok, Instagram, SEO, Facebook/Google ads, email marketing, content strategy. You respond in English with enthusiasm and precision.`,
      es: `Eres un experto en marketing digital, growth hacking y promoción de proyectos en línea. Das consejos CONCRETOS, ACCIONABLES y PERSONALIZADOS sobre: TikTok, Instagram, SEO, anuncios Facebook/Google, email marketing, estrategia de contenido. Respondes en español con entusiasmo y precisión.`
    };
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      system: systemPrompts[lang] || systemPrompts.fr,
      messages: req.body.messages.slice(-10)
    });
    res.json({ reply: response.content[0].text.trim() });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN DASHBOARD (accès privé — soug759@gmail.com uniquement) ──
app.get('/admin', async (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== (process.env.ADMIN_KEY || 'viralboost-admin')) {
    return res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Accès refusé</title>
    <style>body{background:#030a04;color:#f87171;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}
    h1{font-size:56px;margin:0;}p{color:#4a7a58;font-size:14px;}</style></head>
    <body><h1>🚫</h1><p>Accès strictement réservé à l'administrateur.</p></body></html>`);
  }
  try {
    let users = [], reports = [], adminDMs = [];
    if (db) {
      users    = await db.collection('users').find({}).sort({ createdAt: -1 }).toArray();
      reports  = await db.collection('reports').find({}).sort({ createdAt: -1 }).limit(50).toArray();
      adminDMs = await db.collection('admin_dms').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    } else {
      users    = Array.from(inMemoryUsers.values()).sort((a,b) => new Date(b.createdAt||0)-new Date(a.createdAt||0));
      reports  = [...inMemoryReports].reverse();
      adminDMs = [...inMemoryAdminDMs].reverse();
    }

    const total = users.length;
    const plans = { free:0, starter:0, pro:0, elite:0 };
    users.forEach(u => { const p = u.plan||'free'; if(plans[p]!==undefined) plans[p]++; else plans.free++; });

    const revenue = (plans.starter*3 + plans.pro*14.99 + plans.elite*39.99).toFixed(2);
    const payants = plans.starter + plans.pro + plans.elite;
    const today = new Date(); today.setHours(0,0,0,0);
    const newToday = users.filter(u => u.createdAt && new Date(u.createdAt) >= today).length;
    const now = new Date().toLocaleString('fr-FR');
    const KEY = process.env.ADMIN_KEY || 'viralboost-admin';

    res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ViralBoost — Admin Privé</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#030a04;color:#e8fef0;min-height:100vh;}
.topbar{background:#071009;border-bottom:1px solid rgba(34,197,94,.2);padding:16px 32px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:99;}
.logo{font-size:20px;font-weight:900;background:linear-gradient(135deg,#22c55e,#86efac);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.admin-badge{background:rgba(234,179,8,.15);border:1px solid rgba(234,179,8,.3);color:#fbbf24;padding:4px 12px;border-radius:20px;font-size:10px;font-weight:800;letter-spacing:1px;}
.live{display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:#4ade80;padding:5px 13px;border-radius:20px;font-size:11px;font-weight:700;}
.dot{width:7px;height:7px;background:#22c55e;border-radius:50%;animation:blink 1.5s infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.wrap{max-width:1250px;margin:0 auto;padding:28px 24px;}
.meta{color:#2d5a38;font-size:11px;margin-bottom:24px;}
/* Stats */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:36px;}
.card{background:#0a1609;border:1px solid rgba(34,197,94,.12);border-radius:14px;padding:20px;position:relative;overflow:hidden;transition:.2s;}
.card:hover{border-color:rgba(34,197,94,.3);transform:translateY(-1px);}
.card::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:var(--c,linear-gradient(90deg,#22c55e,#4ade80));}
.card.orange{--c:linear-gradient(90deg,#f97316,#fdba74);}
.card.blue{--c:linear-gradient(90deg,#3b82f6,#93c5fd);}
.card.purple{--c:linear-gradient(90deg,#a855f7,#d8b4fe);}
.card.gold{--c:linear-gradient(90deg,#eab308,#fde047);}
.card.red{--c:linear-gradient(90deg,#ef4444,#fca5a5);}
.card.teal{--c:linear-gradient(90deg,#14b8a6,#5eead4);}
.ico{font-size:26px;margin-bottom:8px;}
.num{font-size:34px;font-weight:900;color:#f0fdf4;line-height:1;}
.lbl{font-size:10px;color:#4a7a58;margin-top:5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
.sub{font-size:10px;color:#1a3a1e;margin-top:3px;}
.rev{font-size:28px;font-weight:900;color:#fbbf24;}
/* Section */
.sec{margin-bottom:36px;}
.sec-title{font-size:15px;font-weight:800;color:#22c55e;margin-bottom:12px;display:flex;align-items:center;gap:8px;}
/* Table */
.tbl-wrap{background:#080f09;border:1px solid rgba(34,197,94,.1);border-radius:14px;overflow:auto;}
table{width:100%;border-collapse:collapse;min-width:700px;}
thead tr{background:rgba(34,197,94,.05);}
th{padding:11px 15px;text-align:left;font-size:10px;color:#4a7a58;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border-bottom:1px solid rgba(34,197,94,.08);}
td{padding:11px 15px;border-bottom:1px solid rgba(34,197,94,.04);font-size:13px;vertical-align:middle;}
tbody tr:last-child td{border-bottom:none;}
tbody tr:hover td{background:rgba(34,197,94,.03);}
.num-col{color:#2d5a38;font-size:11px;width:36px;}
/* Badge plan */
.bp{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:800;}
.bp.free{background:rgba(74,122,88,.18);color:#6b9e7a;border:1px solid rgba(74,122,88,.3);}
.bp.starter{background:rgba(34,197,94,.1);color:#4ade80;border:1px solid rgba(34,197,94,.25);}
.bp.pro{background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.3);}
.bp.elite{background:rgba(234,179,8,.12);color:#fbbf24;border:1px solid rgba(234,179,8,.3);}
/* Email */
.em{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);color:#4ade80;padding:2px 9px;border-radius:6px;font-size:11px;font-family:monospace;letter-spacing:.3px;}
/* Status */
.active{color:#22c55e;font-size:11px;font-weight:700;}
.banned{color:#f87171;font-size:11px;font-weight:700;}
/* Empty */
.empty{padding:32px;text-align:center;color:#1a3a1e;font-size:13px;}
/* Refresh */
.btn{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);color:#4ade80;padding:7px 16px;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer;text-decoration:none;}
.btn:hover{background:rgba(34,197,94,.2);}
::-webkit-scrollbar{width:5px;height:5px;}
::-webkit-scrollbar-track{background:#080f09;}
::-webkit-scrollbar-thumb{background:#1a3a1e;border-radius:3px;}
</style></head><body>

<div class="topbar">
  <div style="display:flex;align-items:center;gap:12px;">
    <div class="logo">⚡ ViralBoost</div>
    <div class="admin-badge">👑 ADMIN PRIVÉ</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px;">
    <div class="live"><span class="dot"></span>${onlineUsers.size} en ligne</div>
    <a href="/admin?key=${KEY}" class="btn">🔄 Actualiser</a>
  </div>
</div>

<div class="wrap">
  <div class="meta">🕐 Mis à jour : ${now} &nbsp;·&nbsp; Base : ${db ? '🟢 MongoDB' : '🟡 Mémoire RAM'} &nbsp;·&nbsp; Accès réservé à soug759@gmail.com</div>

  <!-- STATISTIQUES -->
  <div class="grid">
    <div class="card">
      <div class="ico">👥</div>
      <div class="num">${total}</div>
      <div class="lbl">Total inscrits</div>
      <div class="sub">+${newToday} aujourd'hui</div>
    </div>
    <div class="card orange">
      <div class="ico">🆓</div>
      <div class="num">${plans.free}</div>
      <div class="lbl">FREE</div>
      <div class="sub">${total>0?Math.round(plans.free/total*100):0}% des inscrits</div>
    </div>
    <div class="card blue">
      <div class="ico">🚀</div>
      <div class="num">${plans.starter}</div>
      <div class="lbl">STARTER · 3€/mois</div>
      <div class="sub">${(plans.starter*3).toFixed(2)}€ générés</div>
    </div>
    <div class="card purple">
      <div class="ico">💎</div>
      <div class="num">${plans.pro}</div>
      <div class="lbl">PRO · 14,99€/mois</div>
      <div class="sub">${(plans.pro*14.99).toFixed(2)}€ générés</div>
    </div>
    <div class="card gold">
      <div class="ico">👑</div>
      <div class="num">${plans.elite}</div>
      <div class="lbl">ELITE · 39,99€/mois</div>
      <div class="sub">${(plans.elite*39.99).toFixed(2)}€ générés</div>
    </div>
    <div class="card gold">
      <div class="ico">💰</div>
      <div class="rev">${revenue}€</div>
      <div class="lbl">Revenu mensuel estimé</div>
      <div class="sub">${payants} abonné${payants>1?'s':''} payant${payants>1?'s':''}</div>
    </div>
    <div class="card teal">
      <div class="ico">💬</div>
      <div class="num">${publicMessages.length}</div>
      <div class="lbl">Messages chat</div>
    </div>
    <div class="card red">
      <div class="ico">🚨</div>
      <div class="num">${reports.length}</div>
      <div class="lbl">Signalements</div>
    </div>
  </div>

  <!-- TABLEAU UTILISATEURS -->
  <div class="sec">
    <div class="sec-title">👥 Utilisateurs inscrits — ${total} au total</div>
    <div class="tbl-wrap">
      ${users.length===0 ? '<div class="empty">Aucun utilisateur inscrit pour le moment.</div>' : `
      <table>
        <thead><tr>
          <th>#</th>
          <th>Nom</th>
          <th>Adresse email</th>
          <th>Abonnement</th>
          <th>Projets</th>
          <th>Inscrit le</th>
          <th>Statut</th>
        </tr></thead>
        <tbody>
        ${users.map((u,i) => `<tr>
          <td class="num-col">${i+1}</td>
          <td><strong>${u.name||'—'}</strong>${u.username?` <span style="color:#2d5a38;font-size:11px">@${u.username}</span>`:''}</td>
          <td><span class="em">${u.email}</span></td>
          <td><span class="bp ${u.plan||'free'}">${u.plan==='free'?'🆓':u.plan==='starter'?'🚀':u.plan==='pro'?'💎':'👑'} ${(u.plan||'free').toUpperCase()}</span></td>
          <td style="color:#4a7a58;text-align:center">${u.projectsCount||0}</td>
          <td style="color:#4a7a58;font-size:12px">${u.createdAt?new Date(u.createdAt).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—'}</td>
          <td>${u.banned?'<span class="banned">🚫 Banni</span>':'<span class="active">✅ Actif</span>'}</td>
        </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  </div>

  <!-- SIGNALEMENTS -->
  ${reports.length ? `
  <div class="sec">
    <div class="sec-title">🚨 Signalements — ${reports.length}</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>#</th><th>Reporter</th><th>Utilisateur signalé</th><th>Raison</th><th>Détails</th><th>Date</th></tr></thead>
        <tbody>
        ${reports.map((r,i)=>`<tr>
          <td class="num-col">${i+1}</td>
          <td><span class="em">${r.reporterEmail||r.reporterName||'?'}</span></td>
          <td style="color:#f87171;font-weight:700">${r.reportedName||r.reportedId||'?'}</td>
          <td><span class="bp free">${r.reason||'?'}</span></td>
          <td style="font-size:11px;color:#6b9e7a;max-width:220px">${r.details||'—'}</td>
          <td style="font-size:11px;color:#4a7a58">${r.createdAt?new Date(r.createdAt).toLocaleString('fr-FR'):'—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>` : ''}

  <!-- DMS ADMIN -->
  ${adminDMs.length ? `
  <div class="sec">
    <div class="sec-title">📩 DMs Admin ELITE — ${adminDMs.length}</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>#</th><th>De</th><th>Plan</th><th>Message</th><th>Date</th></tr></thead>
        <tbody>
        ${adminDMs.map((d,i)=>`<tr>
          <td class="num-col">${i+1}</td>
          <td><strong>${d.fromName||'?'}</strong><br><span class="em" style="font-size:10px">${d.fromEmail||''}</span></td>
          <td><span class="bp elite">👑 ELITE</span></td>
          <td style="max-width:300px;font-size:12px">${d.text||'—'}</td>
          <td style="font-size:11px;color:#4a7a58">${d.createdAt?new Date(d.createdAt).toLocaleString('fr-FR'):'—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>` : ''}

</div>
</body></html>`);
  } catch(err) { res.status(500).send('Erreur serveur: ' + err.message); }
});

// ── GROUPS ──
const inMemoryGroups = [];
const inMemoryGroupMessages = new Map();

app.get('/api/groups', async (req, res) => {
  try {
    let groups = [];
    if (db) {
      groups = await db.collection('groups').find({}).sort({ createdAt: -1 }).limit(50).toArray();
    } else {
      groups = [...inMemoryGroups];
    }
    res.json(groups);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/groups', async (req, res) => {
  try {
    const group = { ...req.body, id: req.body.id || ('grp_' + Date.now()), createdAt: new Date(), membersCount: 1 };
    if (db) {
      await db.collection('groups').insertOne(group);
    } else {
      inMemoryGroups.unshift(group);
    }
    broadcastToAll({ type: 'new_group', group });
    res.json({ ok: true, group });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/groups/:id/messages', async (req, res) => {
  try {
    let messages = [];
    if (db) {
      messages = await db.collection('group_messages').find({ groupId: req.params.id }).sort({ timestamp: 1 }).limit(100).toArray();
    } else {
      messages = inMemoryGroupMessages.get(req.params.id) || [];
    }
    res.json(messages);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/groups/:id/messages', async (req, res) => {
  try {
    const msg = { ...req.body, groupId: req.params.id, timestamp: new Date() };
    if (db) {
      await db.collection('group_messages').insertOne(msg);
    } else {
      if (!inMemoryGroupMessages.has(req.params.id)) inMemoryGroupMessages.set(req.params.id, []);
      inMemoryGroupMessages.get(req.params.id).push(msg);
    }
    broadcastToAll({ type: 'group_message', groupId: req.params.id, message: msg });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/groups/:id/settings', async (req, res) => {
  try {
    const { settings, requesterId } = req.body;
    if (db) {
      await db.collection('groups').updateOne({ id: req.params.id, creatorId: requesterId }, { $set: settings });
    } else {
      const g = inMemoryGroups.find(g => g.id === req.params.id && g.creatorId === requesterId);
      if (g) Object.assign(g, settings);
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── REPORTS (signalements) ──
const inMemoryReports = [];
app.post('/api/report', async (req, res) => {
  try {
    const report = { ...req.body, createdAt: new Date(), id: 'rep_' + Date.now(), status: 'pending' };
    if (db) {
      await db.collection('reports').insertOne(report);
    } else {
      inMemoryReports.push(report);
    }
    console.log(`🚨 SIGNALEMENT: ${report.reporterEmail} → ${report.reportedName} | ${report.reason}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN DM (messages directs à l'admin) ──
const inMemoryAdminDMs = [];
app.post('/api/admin-dm', async (req, res) => {
  try {
    const dm = { ...req.body, createdAt: new Date(), id: 'adm_' + Date.now(), read: false };
    if (db) {
      await db.collection('admin_dms').insertOne(dm);
    } else {
      inMemoryAdminDMs.push(dm);
    }
    console.log(`📩 DM ADMIN de ${dm.fromEmail} (${dm.fromPlan}): ${dm.text}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN API (Super Admin soug759@gmail.com) ──
const ADMIN_KEY = process.env.ADMIN_KEY || 'viralboost-admin';

app.get('/api/admin/all-users', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  try {
    let users = db ? await db.collection('users').find({}).sort({ createdAt: -1 }).toArray() : Array.from(inMemoryUsers.values());
    res.json(users);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/reports', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  try {
    let reports = db ? await db.collection('reports').find({}).sort({ createdAt: -1 }).toArray() : [...inMemoryReports];
    res.json(reports);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/dms', async (req, res) => {
  if (req.query.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  try {
    let dms = db ? await db.collection('admin_dms').find({}).sort({ createdAt: -1 }).toArray() : [...inMemoryAdminDMs];
    res.json(dms);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ban', async (req, res) => {
  if (req.body.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const { email } = req.body;
    if (db) {
      await db.collection('users').updateOne({ email }, { $set: { banned: true, bannedAt: new Date() } });
    } else {
      const u = inMemoryUsers.get(email);
      if (u) u.banned = true;
    }
    // Déconnecter l'utilisateur s'il est connecté
    sendToUser(email, { type: 'banned', message: 'Ton compte a été suspendu.' });
    console.log(`🚫 BANNI: ${email}`);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  if (req.body?.key !== ADMIN_KEY) return res.status(403).json({ error: 'Accès refusé' });
  try {
    const { id } = req.params;
    if (db) {
      await db.collection('projects').deleteOne({ id });
    } else {
      const idx = inMemoryProjects.findIndex(p => p.id === id);
      if (idx !== -1) inMemoryProjects.splice(idx, 1);
    }
    broadcastToAll({ type: 'project_deleted', projectId: id });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── FALLBACK ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ ViralBoost démarré sur http://localhost:${PORT}`);
  console.log(`📊 Admin : http://localhost:${PORT}/admin?key=viralboost-admin`);
  console.log(`📦 Plans : FREE | STARTER 3€ | PRO 14,99€ | ELITE 39,99€`);
});
