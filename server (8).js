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
        ws.send(JSON.stringify({ type: 'history', messages: publicMessages.slice(-50) }));
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

// ── ADMIN DASHBOARD ──
app.get('/admin', async (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== (process.env.ADMIN_KEY || 'viralboost-admin')) {
    return res.status(403).send('❌ Accès refusé');
  }
  try {
    let users = [];
    if (db) {
      users = await db.collection('users').find({}).sort({ createdAt: -1 }).toArray();
    } else {
      users = Array.from(inMemoryUsers.values());
    }
    const total = users.length;
    const plans = { free: 0, starter: 0, pro: 0, elite: 0 };
    users.forEach(u => { if (plans[u.plan] !== undefined) plans[u.plan]++; else plans.free++; });

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>ViralBoost Admin</title>
    <style>
      body{font-family:system-ui,sans-serif;background:#040a05;color:#f0fdf4;padding:32px;max-width:1100px;margin:0 auto;}
      h1{color:#22c55e;font-size:28px;margin-bottom:4px;}
      .stats{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin:24px 0;}
      .stat{background:#0b1a0d;border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:18px;text-align:center;}
      .stat-num{font-size:28px;font-weight:800;color:#22c55e;}
      .stat-label{font-size:11px;color:#4a7a58;margin-top:4px;}
      table{width:100%;border-collapse:collapse;margin-top:24px;}
      th{background:#0b1a0d;padding:10px 14px;text-align:left;font-size:11px;color:#4a7a58;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid rgba(34,197,94,0.15);}
      td{padding:10px 14px;border-bottom:1px solid rgba(34,197,94,0.06);font-size:13px;}
      tr:hover td{background:rgba(34,197,94,0.04);}
      .badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;}
      .free{background:rgba(74,122,88,0.2);color:#4a7a58;}
      .starter{background:rgba(34,197,94,0.15);color:#4ade80;}
      .pro{background:rgba(34,197,94,0.25);color:#22c55e;}
      .elite{background:rgba(74,222,128,0.2);color:#86efac;}
    </style></head><body>
    <h1>⚡ ViralBoost — Admin</h1>
    <p style="color:#4a7a58;margin-bottom:8px">🟢 ${onlineUsers.size} en ligne · 💬 ${publicMessages.length} messages · 🌐 ${(db ? 'MongoDB' : 'Mémoire')}</p>
    <div class="stats">
      <div class="stat"><div class="stat-num">${total}</div><div class="stat-label">Total inscrits</div></div>
      <div class="stat"><div class="stat-num">${plans.free}</div><div class="stat-label">FREE</div></div>
      <div class="stat"><div class="stat-num">${plans.starter}</div><div class="stat-label">STARTER 3€</div></div>
      <div class="stat"><div class="stat-num">${plans.pro}</div><div class="stat-label">PRO 14,99€</div></div>
      <div class="stat"><div class="stat-num">${plans.elite}</div><div class="stat-label">ELITE 39,99€</div></div>
    </div>
    <table>
      <tr><th>Nom</th><th>Email</th><th>Plan</th><th>Projets</th><th>Inscrit le</th></tr>
      ${users.map(u => `
        <tr>
          <td>${u.name || '—'}</td>
          <td>${u.email}</td>
          <td><span class="badge ${u.plan || 'free'}">${(u.plan || 'free').toUpperCase()}</span></td>
          <td>${u.projectsCount || 0}</td>
          <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString('fr-FR') : '—'}</td>
        </tr>`).join('')}
    </table>
    </body></html>`;
    res.send(html);
  } catch(err) { res.status(500).send('Erreur: ' + err.message); }
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
