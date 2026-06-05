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

// Move the routes before the static middleware (registered at index 2)
const stack = app._router.stack;
const added = stack.splice(stack.length - 5, 5);
stack.splice(2, 0, ...added);

// Socket.io for puz royale — polling only to avoid conflict with curvytron's faye-websocket
const { Server: IOServer } = require('socket.io');
const io = new IOServer(curv.server, {
    transports: ['polling'],
    path: '/socket.io'
});

const puz = require('./puz-server');

io.on('connection', (socket) => {
    socket.on('puz:join', ({roomId, name, color}) => {
        let room = puz.puzRooms[roomId];
        if(!room) room = puz.createPuzRoom(roomId);
        socket.join(roomId);
        puz.addHumanPlayer(room, socket.id, name, color);
        const humans = Object.values(room.players).filter(p=>!p.isBot);
        const hostId = humans[0].id;
        io.to(roomId).emit('puz:lobby', {players:humans.map(p=>({id:p.id,name:p.name,color:p.color})), hostId});
    });

    socket.on('puz:start', ({roomId}) => {
        const room = puz.puzRooms[roomId];
        if(!room || room.active) return;
        const humans = Object.values(room.players).filter(p=>!p.isBot).length;
        const botsNeeded = Math.max(0, 8-humans);
        for(let i=0;i<botsNeeded;i++) puz.addBot(room,i);
        puz.startPuzRoom(room, io);
        io.to(roomId).emit('puz:started', {walls:room.walls});
    });

    socket.on('puz:input', ({roomId, input}) => {
        const room = puz.puzRooms[roomId];
        if(!room || !room.players[socket.id]) return;
        room.players[socket.id].input = input;
    });

    socket.on('puz:reload', ({roomId}) => {
        const room = puz.puzRooms[roomId];
        if(!room || !room.players[socket.id]) return;
        const p = room.players[socket.id];
        if(!p.reloading && p.ammo < p.maxAmmo){p.reloading=true;p.reloadTimer=90;}
    });
});
