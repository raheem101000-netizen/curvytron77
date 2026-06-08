process.chdir(__dirname);
require('dotenv').config();
var config;
try { config = require('./config.json'); } catch(e) { config = { port: process.env.PORT || 8080, inspector: { enabled: false } }; }
if (process.env.PORT) config.port = process.env.PORT;
const curv = require('./bin/curvytron.js');
const path = require('path');
const express = require('express');
const app = curv.app;

// Stripe webhook must use raw body — register before json middleware
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const db = require('./db');
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const email = session.customer_details?.email;
        const paymentIntentId = session.payment_intent;
        if (email && paymentIntentId) {
            await db.addBalance(email, 0, 'entry_fee_paid', paymentIntentId);
        }
    }
    res.json({ received: true });
});

app.use(express.json());

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('./db');
db.initDb().catch(console.error);

// Solo Challenge checkout — $2.99
app.post('/create-solo-checkout', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Kurver Solo Challenge',
                        description: 'Play 20 matches. Win up to $100.',
                    },
                    unit_amount: 299,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/solo-game?paid=true&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/solo`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Payment failed' });
    }
});

// Multiplayer checkout — $2 per player
app.post('/create-multiplayer-checkout', async (req, res) => {
    try {
        const { roomName, playerName } = req.body;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Kurver Multiplayer Entry',
                        description: `Room: ${roomName}`,
                    },
                    unit_amount: 200,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/multiplayer?paid=true&room=${roomName}&player=${playerName}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.BASE_URL}/multiplayer`,
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Payment failed' });
    }
});

// Check balance
app.get('/balance', async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const balance = await db.getBalance(email);
    res.json({ balance });
});

// Credit winner after game ends
app.post('/credit-winner', async (req, res) => {
    try {
        const { email, amount, description } = req.body;
        const secret = req.headers['x-internal-secret'];
        if (secret !== process.env.INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
        await db.addBalance(email, amount, description, null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Withdraw — automatic payout to original payment method
app.post('/withdraw', async (req, res) => {
    try {
        const { email } = req.body;
        const balance = await db.getBalance(email);
        if (balance <= 0) return res.status(400).json({ error: 'No balance to withdraw' });
        const paymentIntentId = await db.getLatestPaymentIntent(email);
        if (!paymentIntentId) return res.status(400).json({ error: 'No payment method found' });
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        const chargeId = paymentIntent.latest_charge;
        const amountInCents = Math.floor(balance * 100);
        const refund = await stripe.refunds.create({
            charge: chargeId,
            amount: amountInCents,
        });
        await db.deductBalance(email, balance);
        await db.createWithdrawal(email, balance, refund.id);
        res.json({ success: true, amount: balance });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web/home.html')));
app.get('/solo', (req, res) => res.sendFile(path.join(__dirname, 'web/solo-info.html')));
app.get('/solo-game', (req, res) => res.sendFile(path.join(__dirname, 'web/solo.html')));
app.get('/multiplayer', (req, res) => res.sendFile(path.join(__dirname, 'web/index.html')));
app.get('/puz', (req, res) => res.sendFile(path.join(__dirname, 'web/puz.html')));
app.get('/puz-home', (req, res) => res.sendFile(path.join(__dirname, 'web/puz-home.html')));
app.get('/wallet', (req, res) => res.sendFile(path.join(__dirname, 'web/wallet.html')));

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
