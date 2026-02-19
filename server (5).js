const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── FICHIERS STATIQUES ──
app.use(express.static(path.join(__dirname, '.')));

// ── ROUTE PRINCIPALE ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_VOTRE_CLE');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'VOTRE_CLE' });

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

// ── 404 FALLBACK ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ViralBoost sur http://localhost:${PORT}`));
