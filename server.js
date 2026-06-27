process.chdir(__dirname);
require('dotenv').config();
const { Pool } = require('pg');
const neonPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;
var config;
try { config = require('./config.json'); } catch(e) { config = { port: process.env.PORT || 8080, inspector: { enabled: false } }; }
if (process.env.PORT) config.port = process.env.PORT;
const curv = require('./bin/curvytron.js');
const path = require('path');
const express = require('express');
const app = curv.app;

// Stripe webhook must use raw body — register before json middleware
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
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
        if (neonPool) {
            const mode = session.metadata?.mode || 'multiplayer';
            const amount = mode === 'solo' ? 2.99 : 2.00;
            await neonPool.query(
                'INSERT INTO sessions (game, mode, amount, stripe_payment_id) VALUES ($1, $2, $3, $4)',
                ['Kurver', mode, amount, session.payment_intent]
            ).catch(console.error);
        }
    }
    res.json({ received: true });
});

app.use(express.json());

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const db = require('./db');
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (process.env.KURVER_DATABASE_URL) db.initDb().catch(console.error);

async function payoutWinner(email, amount, description) {
    try {
        let connectId = await db.getConnectAccount(email);

        if (!connectId) {
            const account = await stripe.accounts.create({
                type: 'express',
                email: email,
                capabilities: { transfers: { requested: true } },
            });
            connectId = account.id;
            await db.addBalance(email, 0, 'account_created', null);
            await db.saveConnectAccount(email, connectId);
            const accountLink = await stripe.accountLinks.create({
                account: connectId,
                refresh_url: `${process.env.BASE_URL}/wallet`,
                return_url: `${process.env.BASE_URL}/wallet?onboarded=true`,
                type: 'account_onboarding',
            });
            await resend.emails.send({
                from: 'Kurver <noreply@kurver.gg>',
                to: email,
                subject: `You won $${amount}! Set up your payout account`,
                html: `
                    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;">
                        <h2 style="color:#50c8ff;">🎉 You won $${amount}!</h2>
                        <p style="color:#333;margin:16px 0;">Congratulations! You have <strong>$${amount}</strong> waiting for you from Kurver.</p>
                        <p style="color:#333;margin:16px 0;">Set up your payout account to receive your winnings. This takes 2-3 minutes and you only need to do it once.</p>
                        <a href="${accountLink.url}" style="display:inline-block;background:#50c8ff;color:#020818;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Set Up Payout Account →</a>
                        <p style="color:#999;font-size:12px;margin-top:24px;">Once set up, all future winnings will be paid automatically to your debit card or bank account.</p>
                    </div>
                `
            });
            await db.addBalance(email, amount, description, null);
            console.log(`Onboarding email sent to ${email} for $${amount}`);
            return { status: 'onboarding_required', email };
        }

        const account = await stripe.accounts.retrieve(connectId);

        if (!account.charges_enabled) {
            const accountLink = await stripe.accountLinks.create({
                account: connectId,
                refresh_url: `${process.env.BASE_URL}/wallet`,
                return_url: `${process.env.BASE_URL}/wallet?onboarded=true`,
                type: 'account_onboarding',
            });
            await resend.emails.send({
                from: 'Kurver <noreply@kurver.gg>',
                to: email,
                subject: `Complete your payout setup to receive $${amount}`,
                html: `
                    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:24px;">
                        <h2 style="color:#50c8ff;">💰 $${amount} is waiting for you</h2>
                        <p style="color:#333;margin:16px 0;">You haven't completed your payout account setup yet. Complete it now to receive your winnings.</p>
                        <a href="${accountLink.url}" style="display:inline-block;background:#50c8ff;color:#020818;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:16px 0;">Complete Setup →</a>
                    </div>
                `
            });
            await db.addBalance(email, amount, description, null);
            return { status: 'onboarding_incomplete', email };
        }

        const amountInCents = Math.floor(amount * 100);
        const transfer = await stripe.transfers.create({
            amount: amountInCents,
            currency: 'usd',
            destination: connectId,
            description: description,
        });
        await db.addBalance(email, amount, description, null);
        await db.deductBalance(email, amount);
        await db.createWithdrawal(email, amount, transfer.id);
        console.log(`Payout $${amount} sent to ${email}`);
        return { status: 'paid', transfer_id: transfer.id };

    } catch (err) {
        console.error('Payout error:', err);
        await db.addBalance(email, amount, description + '_fallback', null);
        throw err;
    }
}

// Solo Challenge checkout — $2.99
app.post('/create-solo-checkout', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
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
            metadata: { mode: 'solo' },
        });
        res.json({ url: session.url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Payment failed' });
    }
});

// Multiplayer checkout — $2 per player
app.post('/create-multiplayer-checkout', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
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
            metadata: { mode: 'multiplayer' },
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
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
    try {
        const { email, amount, description } = req.body;
        const secret = req.headers['x-internal-secret'];
        if (secret !== process.env.INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
        const result = await payoutWinner(email, amount, description || 'game_win');
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Withdraw — automatic payout to original payment method
app.post('/withdraw', async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
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
