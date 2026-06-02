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

// Move the routes before the static middleware (registered at index 2)
const stack = app._router.stack;
const added = stack.splice(stack.length - 4, 4);
stack.splice(2, 0, ...added);
