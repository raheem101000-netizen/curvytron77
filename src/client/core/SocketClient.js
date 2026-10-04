/**
 * SocketClient
 */
function SocketClient()
{
    this.id        = null;
    this.connected = false;

    this.onError      = this.onError.bind(this);
    this.onOpen       = this.onOpen.bind(this);
    this.onConnection = this.onConnection.bind(this);

    var Socket = window.MozWebSocket || window.WebSocket;

    var protocol = 'ws://';
    if(location.protocol === 'https:') {
        protocol = 'wss://';
    }

    // tenten.run login handoff (stored by the page from #token=…&player_id=…);
    // the server refuses any socket without a valid one.
    var auth = null;
    try { auth = JSON.parse(window.sessionStorage.getItem('kurver_auth')); } catch (e) {}
    var query = auth && auth.token ? '?token=' + encodeURIComponent(auth.token) + '&player_id=' + encodeURIComponent(auth.playerId) : '';

    BaseSocketClient.call(this, new Socket(protocol + document.location.host + document.location.pathname + query, ['websocket']));

    this.socket.addEventListener('open', this.onOpen);
    this.socket.addEventListener('error', this.onError);
    this.socket.addEventListener('close', this.onClose);
}

SocketClient.prototype = Object.create(BaseSocketClient.prototype);
SocketClient.prototype.constructor = SocketClient;

/**
 * Heartbeat: every 5 s ask the server for an answer. No answer for 15 s means
 * the connection is dead even if the socket never said so (phone asleep,
 * network switch) — close it, which starts the reconnection.
 *
 * @type {Number}
 */
SocketClient.prototype.heartbeatInterval = 5000;
SocketClient.prototype.heartbeatTimeout  = 15000;

/**
 * Start the heartbeat
 */
SocketClient.prototype.startHeartbeat = function()
{
    var client = this;

    this.stopHeartbeat();
    this.lastAck   = new Date().getTime();
    this.heartbeat = setInterval(function () { client.beat(); }, this.heartbeatInterval);

    if (!this.onVisible) {
        this.onVisible = function () {
            if (document.visibilityState !== 'hidden') { client.beat(); }
        };
        document.addEventListener('visibilitychange', this.onVisible);
        window.addEventListener('pageshow', this.onVisible);
        window.addEventListener('online', this.onVisible);
    }
};

/**
 * Stop the heartbeat
 */
SocketClient.prototype.stopHeartbeat = function()
{
    if (this.heartbeat) {
        this.heartbeat = clearInterval(this.heartbeat);
    }
};

/**
 * One beat
 */
SocketClient.prototype.beat = function()
{
    if (!this.connected) { return; }

    var client = this;

    if (new Date().getTime() - this.lastAck > this.heartbeatTimeout) {
        console.info('No answer from the server: reconnecting.');
        this.stopHeartbeat();
        try { this.socket.close(); } catch (e) {}
        this.onClose();
        return;
    }

    this.addEvent('hb', null, function () { client.lastAck = new Date().getTime(); });
};

/**
 * On socket connection
 *
 * @param {Socket} socket
 */
SocketClient.prototype.onOpen = function(e)
{
    console.info('Socket open.');
    this.addEvent('whoami', null, this.onConnection);
};

/**
 * On open
 *
 * @param {Event} e
 */
SocketClient.prototype.onConnection = function(id)
{
    console.info('Connected with id "%s".', id);

    this.id        = id;
    this.connected = true;

    this.start();
    this.startHeartbeat();
    this.emit('connected');
};

/**
 * On open
 *
 * @param {Event} e
 */
SocketClient.prototype.onClose = function(e)
{
    console.info('Disconnected.');

    this.connected = false;
    this.id        = null;

    this.stop();
    this.stopHeartbeat();

    this.emit('disconnected');
};

/**
 * On error
 *
 * @param {Event} e
 */
SocketClient.prototype.onError = function (e)
{
    console.error(e);

    if (!this.connected) {
        this.onClose();
    }
};
