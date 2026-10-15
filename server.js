process.chdir(__dirname);
require('dotenv').config();
const { Pool } = require('pg');
const neonPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;
if (neonPool) {
    neonPool.query(`
        CREATE TABLE IF NOT EXISTS prize_claims (
            id SERIAL PRIMARY KEY,
            winner_name TEXT NOT NULL,
            paypal_email TEXT,
            contact_email TEXT,
            notes TEXT,
            game TEXT NOT NULL,
            prize_amount TEXT NOT NULL,
            paid BOOLEAN DEFAULT FALSE,
            claimed_at TIMESTAMP DEFAULT NOW()
        )
    `).catch(console.error);
}
var config;
try { config = require('./config.json'); } catch(e) { config = { port: process.env.PORT || 8080, inspector: { enabled: false } }; }
if (process.env.PORT) config.port = process.env.PORT;
const curv = require('./bin/curvytron.js');
const path = require('path');
const express = require('express');
const app = curv.app;

// Stripe webhook for entry fees (kurver-pay.js) — raw body, so it's
// registered before the JSON middleware. The old $2 multiplayer Checkout and
// its webhook (which logged every checkout on the account as a Kurver sale)
// are gone.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), require('./kurver-pay.js').webhookHandler('kurver'));

app.use(express.json());

const db = require('./db');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (process.env.KURVER_DATABASE_URL) db.initDb().catch(console.error);

// Winner prize claim form submission
app.post('/submit-prize-claim', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const { winner_name, paypal_email, contact_email, notes, game, prize_amount } = req.body;
    if (neonPool) {
        await neonPool.query(
            'INSERT INTO prize_claims (winner_name, paypal_email, contact_email, notes, game, prize_amount, claimed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
            [winner_name, paypal_email || '', contact_email || '', notes || '', game, prize_amount]
        ).catch(console.error);
    }
    res.json({ success: true });
});
app.options('/admin/prize-claims', (_req, res) => { res.set('Access-Control-Allow-Origin','*').set('Access-Control-Allow-Methods','GET,OPTIONS').set('Access-Control-Allow-Headers','Content-Type').sendStatus(204); });
app.options('/admin/mark-paid',     (_req, res) => { res.set('Access-Control-Allow-Origin','*').set('Access-Control-Allow-Methods','POST,OPTIONS').set('Access-Control-Allow-Headers','Content-Type').sendStatus(204); });
app.get('/admin/prize-claims', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.query.key !== 'TENTEN2025') { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (!neonPool) { res.json([]); return; }
    try {
        const result = await neonPool.query('SELECT * FROM prize_claims WHERE paid = false AND game = \'Kurver Multiplayer\' ORDER BY claimed_at DESC');
        res.json(result.rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});
app.post('/admin/mark-paid', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.query.key !== 'TENTEN2025') { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (!neonPool) { res.json({ success: false }); return; }
    try {
        await neonPool.query('UPDATE prize_claims SET paid = true WHERE id = $1', [req.body.id]);
        res.json({ success: true });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// Is this tenten.run login (the page's stored handoff) still accepted? 204 yes, 401 no.
app.get('/auth-check', (req, res) => {
    res.set('Cache-Control', 'no-store');
    require('./kurver-money.js').authenticate(req.query.token, req.query.player_id)
        .then(() => res.status(204).end())
        .catch(e => res.status(e instanceof require('./kurver-money.js').AuthError ? 401 : 500).end());
});

// Kurver's own solo/multiplayer chooser (web/home.html) is no longer a
// destination: players land straight on the multiplayer lobby. Restore with
// res.sendFile(path.join(__dirname, 'web/home.html')).
app.get('/', (req, res) => res.redirect(302, '/multiplayer'));
app.get('/multiplayer', (req, res) => res.sendFile(path.join(__dirname, 'web/index.html')));
app.get('/puz', (req, res) => res.sendFile(path.join(__dirname, 'web/puz.html')));
app.get('/puz-home', (req, res) => res.sendFile(path.join(__dirname, 'web/puz-home.html')));

// Move the routes before the static middleware (registered at index 2)
const stack = app._router.stack;
const added = stack.splice(stack.length - 7, 7);
stack.splice(2, 0, ...added);

// Socket.io for puz royale — polling only to avoid conflict with curvytron's faye-websocket
const { Server: IOServer } = require('socket.io');
const io = new IOServer(curv.server, {
    transports: ['polling'],
    path: '/socket.io'
});

const registerPuzHandlers = require('./puz-server');

io.on('connection', (socket) => {
    registerPuzHandlers(io, socket);
});
