process.chdir(__dirname);
var config;
try { config = require('./config.json'); } catch(e) { config = { port: process.env.PORT || 8080, inspector: { enabled: false } }; }
if (process.env.PORT) config.port = process.env.PORT;
const curv = require('./bin/curvytron.js');
const path = require('path');
const app = curv.app;
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web/home.html')));
app.get('/solo', (req, res) => res.sendFile(path.join(__dirname, 'web/solo.html')));
app.get('/multiplayer', (req, res) => res.sendFile(path.join(__dirname, 'web/index.html')));

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
    const { playerId, roomName, playerName } = req.body;
    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
            price_data: {
                currency: 'usd',
                product_data: {
                    name: 'Kurver Room Entry',
                    description: `Room: ${roomName}`,
                },
                unit_amount: 200,
            },
            quantity: 1,
        }],
        mode: 'payment',
        success_url: `${process.env.BASE_URL}/multiplayer#/room/${roomName}?paid=true&playerId=${playerId}`,
        cancel_url: `${process.env.BASE_URL}/multiplayer#/room/${roomName}`,
        metadata: { playerId, roomName, playerName }
    });
    res.json({ url: session.url });
});

app.post('/webhook', curv.express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('Payment confirmed:', session.metadata);
    }
    res.json({received: true});
});

// Move the routes before the static middleware (registered at index 2)
const stack = app._router.stack;
const added = stack.splice(stack.length - 5, 5);
stack.splice(2, 0, ...added);
