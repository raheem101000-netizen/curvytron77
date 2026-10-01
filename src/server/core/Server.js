/**
 * Server
 */
function Server(config)
{
    EventEmitter.call(this);

    this.config  = config;
    this.app     = express();
    this.server  = new http.Server(this.app);
    this.clients = new Collection([], 'id', true);

    this.roomRepository  = new RoomRepository();
    this.roomsController = new RoomsController(this.roomRepository);

    this.authorizationHandler  = this.authorizationHandler.bind(this);
    this.onSocketConnection    = this.onSocketConnection.bind(this);
    this.onSocketDisconnection = this.onSocketDisconnection.bind(this);
    this.onError               = this.onError.bind(this);

    this.app.use(express['static']('web'));

    var self = this;
    this.app.get('/status', function(req, res) {
        // Public, read-only status check polled cross-origin from the
        // admin dashboard — no sensitive data, so a wildcard is fine.
        res.set('Access-Control-Allow-Origin', '*');
        res.json({
            game: 'Kurver',
            activePlayers: self.clients.count(),
            activeRooms: self.roomRepository.rooms.count(),
            timestamp: new Date().toISOString()
        });
    });

    this.server.on('error', this.onError);
    this.server.on('upgrade', this.authorizationHandler);
    this.server.listen(config.port);

    console.info('Listening on port %s', config.port);
}

Server.prototype = Object.create(EventEmitter.prototype);
Server.prototype.constructor = Server;

/**
 * Authorization Handler
 *
 * @param {Object} request
 * @param {Object} socket
 * @param {Buffer} body
 */
Server.prototype.authorizationHandler = function(request, socket, head)
{
    if (!WebSocket.isWebSocket(request)) {
        return socket.end();
    }

    // Every multiplayer socket must carry a valid tenten.run login handoff
    // (?token=…&player_id=… on the upgrade URL). Checked BEFORE the socket is
    // accepted; anything else is refused with a 401 and never connects.
    var server = this;

    KurverMoney.authenticateUpgrade(request.url).then(function (auth) {
        var websocket = new WebSocket(request, socket, head, ['websocket'], {ping: 30}),
            ip = request.headers['x-real-ip'] || request.connection.remoteAddress;

        server.onSocketConnection(websocket, ip, auth);
    }).catch(function (error) {
        var message = error instanceof KurverMoney.AuthError ? error.message : 'Login check failed';
        if (!(error instanceof KurverMoney.AuthError)) { console.error('[kurver-auth]', error); }
        try { socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' + message); } catch (e) {}
        socket.destroy();
    });
};

/**
 * On socket connection
 *
 * @param {Socket} socket
 * @param {String} ip
 */
Server.prototype.onSocketConnection = function(socket, ip, auth)
{
    var client = new SocketClient(socket, 1, ip);
    client.userId      = auth ? auth.userId : null;      // real tenten.run account
    client.displayName = auth ? auth.displayName : null;
    this.clients.add(client);

    client.on('close', this.onSocketDisconnection);
    this.roomsController.attach(client);
    this.emit('client', client);

    console.info('Client %s connected.', client.id);
};

/**
 * On socket connection
 *
 * @param {SocketClient} client
 */
Server.prototype.onSocketDisconnection = function(client)
{
    console.info('Client %s disconnected.', client.id);

    this.clients.remove(client);
};

/**
 * On error
 *
 * @param {Error} error
 */
Server.prototype.onError = function(error)
{
    console.error('Server Error:', error.stack);
};
