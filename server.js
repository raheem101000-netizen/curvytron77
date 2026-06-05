process.chdir(__dirname);
var config;
try { config = require('./config.json'); } catch(e) { config = { port: process.env.PORT || 8080, inspector: { enabled: false } }; }
if (process.env.PORT) config.port = process.env.PORT;
const curv = require('./bin/curvytron.js');
const path = require('path');
const app = curv.app;
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web/home.html')));
app.get('/solo', (req, res) => res.sendFile(path.join(__dirname, 'web/solo-info.html')));
app.get('/solo-game', (req, res) => res.sendFile(path.join(__dirname, 'web/solo.html')));
app.get('/multiplayer', (req, res) => res.sendFile(path.join(__dirname, 'web/index.html')));
app.get('/puz', (req, res) => res.sendFile(path.join(__dirname, 'web/puz.html')));
app.get('/puz-home', (req, res) => res.sendFile(path.join(__dirname, 'web/puz-home.html')));

// Move the routes before the static middleware (registered at index 2)
const stack = app._router.stack;
const added = stack.splice(stack.length - 6, 6);
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
