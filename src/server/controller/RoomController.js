/**
 * Room Controller
 *
 * @param {Room} room
 */
function RoomController(room)
{
    EventEmitter.call(this);

    var controller = this;

    this.room        = room;
    this.clients     = new Collection();
    this.socketGroup = new SocketGroup(this.clients);
    this.kickManager = new KickManager(this);
    this.chat        = new Chat();
    this.roomMaster  = null;
    this.launching   = null;

    this.onPlayerJoin     = this.onPlayerJoin.bind(this);
    this.onPlayerLeave    = this.onPlayerLeave.bind(this);
    this.onGame           = this.onGame.bind(this);
    this.loadRoom         = this.loadRoom.bind(this);
    this.unloadRoom       = this.unloadRoom.bind(this);
    this.onVoteNew        = this.onVoteNew.bind(this);
    this.onVoteClose      = this.onVoteClose.bind(this);
    this.onKick           = this.onKick.bind(this);
    this.checkForClose    = this.checkForClose.bind(this);
    this.removeRoomMaster = this.removeRoomMaster.bind(this);
    this.onPlayersClear   = this.onPlayersClear.bind(this);
    this.launch           = this.launch.bind(this);
    this.sweep            = this.sweep.bind(this);

    this.callbacks = {
        onTalk: function (data) { controller.onTalk(this, data[0], data[1]); },
        onPlayerAdd: function (data) { controller.onPlayerAdd(this, data[0], data[1]); },
        onPlayerRemove: function (data) { controller.onPlayerRemove(this, data[0], data[1]); },
        onReady: function (data) { controller.onReady(this, data[0], data[1]); },
        onKickVote: function (data) { controller.onKickVote(this, data[0], data[1]); },
        onName: function (data) { controller.onName(this, data[0], data[1]); },
        onColor: function (data) { controller.onColor(this, data[0], data[1]); },
        onLeave: function () { controller.onLeave(this); },
        onDrop: function () { controller.onDrop(this); },
        onActivity: function () { controller.onActivity(this); },

        onConfigOpen: function (data) { controller.onConfigOpen(this, data[0], data[1]); },
        onConfigMaxScore: function (data) { controller.onConfigMaxScore(this, data[0], data[1]); },
        onConfigVariable: function (data) { controller.onConfigVariable(this, data[0], data[1]); },
        onConfigBonus: function (data) { controller.onConfigBonus(this, data[0], data[1]); },
        onLaunch: function (data) { controller.onLaunch(this); }
    };

    this.loadRoom();
    this.promptCheckForClose();

    // Seats belong to accounts (same model as FIFA): a dropped connection keeps
    // its seat and the player can come back to it; presence is checked every 2 s.
    this.presenceLoop = setInterval(this.sweep, 2000);
}

RoomController.prototype = Object.create(EventEmitter.prototype);
RoomController.prototype.constructor = RoomController;

/**
 * Time before closing an empty room
 *
 * @type {Number}
 */
RoomController.prototype.timeToClose = 10000;

/**
 * Presence (account-owned seats). A player whose connection goes quiet for
 * awayAfter is shown as away; an away host hands over after hostHandoffAfter;
 * an away seat is released after seatHold. Overridable for local tests only —
 * leave the KURVER_* variables unset in production.
 *
 * @type {Number}
 */
RoomController.prototype.awayAfter        = Number(process.env.KURVER_AWAY_AFTER_MS) || 15000;
RoomController.prototype.hostHandoffAfter = Number(process.env.KURVER_HOST_HANDOFF_MS) || 60000;
RoomController.prototype.seatHold         = Number(process.env.KURVER_SEAT_HOLD_MS) || 12 * 60 * 1000;

/**
 * Load room
 */
RoomController.prototype.loadRoom = function()
{
    this.room.on('close', this.unloadRoom);
    this.room.on('player:join', this.onPlayerJoin);
    this.room.on('player:leave', this.onPlayerLeave);
    this.room.on('game:new', this.onGame);
    this.kickManager.on('kick', this.onKick);
    this.kickManager.on('vote:new', this.onVoteNew);
    this.kickManager.on('vote:close', this.onVoteClose);
};

/**
 * Load room
 */
RoomController.prototype.unloadRoom = function()
{
    this.room.removeListener('close', this.unloadRoom);
    this.room.removeListener('player:join', this.onPlayerJoin);
    this.room.removeListener('player:leave', this.onPlayerLeave);
    this.room.removeListener('game:new', this.onGame);
    this.kickManager.removeListener('kick', this.onKick);
    this.kickManager.removeListener('vote:new', this.onVoteNew);
    this.kickManager.removeListener('vote:close', this.onVoteClose);
    this.kickManager.clear();

    if (this.presenceLoop) {
        this.presenceLoop = clearInterval(this.presenceLoop);
    }
};

/**
 * Attach events
 *
 * @param {SocketClient} client
 * @param {Function} callback
 */
RoomController.prototype.attach = function(client, callback)
{
    if (this.clients.add(client)) {
        this.attachEvents(client);
        this.onClientAdd(client);
        // Coming back to a seat this account already holds: take it over
        // (before the room is sent, so the player sees their own seat).
        this.socketGroup.addEvent('client:add', client.id);
        this.takeOverSeat(client);
        callback({
            success: true,
            room: this.room.serialize(),
            master: this.roomMaster ? this.roomMaster.id : null,
            clients: this.clients.map(function () { return this.serialize(); }).items,
            messages: this.chat.serialize(100),
            votes: this.kickManager.votes.map(function () { return this.serialize(); }).items
        });
        this.emit('client:add', { room: this.room, client: client});
    } else {
        callback({success: false, error: 'Client ' + client.id + ' already in the room.'});
    }
    this.checkIntegrity();
};

/**
 * Attach events
 *
 * @param {SocketClient} client
 */
RoomController.prototype.detach = function(client)
{
    if (this.clients.remove(client)) {
        if (this.room.game) {
            this.room.game.controller.detach(client);
        }

        client.clearPlayers();
        this.detachEvents(client);
        this.promptCheckForClose();
        this.socketGroup.addEvent('client:remove', client.id);
        this.emit('client:remove', { room: this.room, client: client});
    }
    this.checkIntegrity();
};

/**
 * Detach events
 *
 * @param {SocketClient} client
 */
RoomController.prototype.attachEvents = function(client)
{
    // A closed connection is a drop (seat kept), not a leave: 'room:leave' is
    // the only way to give a seat up yourself.
    client.on('close', this.callbacks.onDrop);
    client.on('activity', this.callbacks.onActivity);
    client.on('room:leave', this.callbacks.onLeave);
    client.on('room:talk', this.callbacks.onTalk);
    client.on('player:add', this.callbacks.onPlayerAdd);
    client.on('player:remove', this.callbacks.onPlayerRemove);
    client.on('player:kick', this.callbacks.onKickVote);
    client.on('room:ready', this.callbacks.onReady);
    client.on('room:color', this.callbacks.onColor);
    client.on('room:name', this.callbacks.onName);
    client.on('players:clear', this.onPlayersClear);
};

/**
 * Detach events
 *
 * @param {SocketClient} client
 */
RoomController.prototype.detachEvents = function(client)
{
    client.removeListener('close', this.callbacks.onDrop);
    client.removeListener('activity', this.callbacks.onActivity);
    client.removeListener('room:leave', this.callbacks.onLeave);
    client.removeListener('room:talk', this.callbacks.onTalk);
    client.removeListener('player:add', this.callbacks.onPlayerAdd);
    client.removeListener('player:remove', this.callbacks.onPlayerRemove);
    client.removeListener('player:kick', this.callbacks.onKickVote);
    client.removeListener('room:ready', this.callbacks.onReady);
    client.removeListener('room:color', this.callbacks.onColor);
    client.removeListener('room:name', this.callbacks.onName);
    client.removeListener('players:clear', this.onPlayersClear);
};

/**
 * Remove player
 *
 * @param {Player} player
 */
RoomController.prototype.removePlayer = function(player)
{
    var client = player.client;

    if (this.room.removePlayer(player) && client) {
        client.players.remove(player);

        if (!client.isPlaying()) {
            this.kickManager.removeClient(client);

            if (this.roomMaster && this.roomMaster.id === client.id) {
                this.removeRoomMaster();
            }
        }
    }
};

/**
 * Nominate game master
 */
RoomController.prototype.nominateRoomMaster = function()
{
    if (this.clients.isEmpty() || this.roomMaster) { return; }

    var roomMaster = this.clients.match(function () { return this.active && !this.away && this.isPlaying(); });

    this.setRoomMaster(roomMaster);
};

/**
 * Set game master
 *
 * @param {SocketClient} client
 */
RoomController.prototype.setRoomMaster = function(client)
{
    if (!this.roomMaster && client) {
        this.roomMaster = client;
        // A dropped host keeps the host role while their seat is held (it
        // passes on after hostHandoffAfter, see sweep()).
        this.roomMaster.on('room:leave', this.removeRoomMaster);
        this.roomMaster.on('room:config:open', this.callbacks.onConfigOpen);
        this.roomMaster.on('room:config:max-score', this.callbacks.onConfigMaxScore);
        this.roomMaster.on('room:config:variable', this.callbacks.onConfigVariable);
        this.roomMaster.on('room:config:bonus', this.callbacks.onConfigBonus);
        this.roomMaster.on('room:launch', this.callbacks.onLaunch);
        this.socketGroup.addEvent('room:master', {client: client.id});
    }
};

/**
 * Remove game master
 */
RoomController.prototype.removeRoomMaster = function()
{
    if (this.roomMaster) {
        this.releaseRoomMaster();
        this.nominateRoomMaster();
    }
};

/**
 * Drop the current game master without nominating a new one
 */
RoomController.prototype.releaseRoomMaster = function()
{
    if (this.roomMaster) {
        this.roomMaster.removeListener('room:leave', this.removeRoomMaster);
        this.roomMaster.removeListener('room:config:open', this.callbacks.onConfigOpen);
        this.roomMaster.removeListener('room:config:max-score', this.callbacks.onConfigMaxScore);
        this.roomMaster.removeListener('room:config:variable', this.callbacks.onConfigVariable);
        this.roomMaster.removeListener('room:config:bonus', this.callbacks.onConfigBonus);
        this.roomMaster.removeListener('room:launch', this.callbacks.onLaunch);
        this.roomMaster = null;
    }
};

/**
 * Is the given client the game master?
 *
 * @param {SocketClient} client
 *
 * @return {Boolean}
 */
RoomController.prototype.isRoomMaster = function(client)
{
    return this.roomMaster.id === client.id;
};

/**
 * Initialise a new client
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onClientAdd = function(client)
{
    client.clearPlayers();

    if (this.room.game) {
        this.room.game.controller.attach(client);
        client.addEvent('room:game:start');
    }

    this.socketGroup.addEvent('client:add', {client: client.serialize()});
    this.nominateRoomMaster();
};

/**
 * Prompt a check for close
 */
RoomController.prototype.promptCheckForClose = function() {
    if (this.clients.isEmpty()) {
        setTimeout(this.checkForClose, this.timeToClose);
    }
};

/**
 * Check is room is empty and shoul be closed
 */
RoomController.prototype.checkForClose = function()
{
    if (this.clients.isEmpty()) {
        this.room.close();
    }
};

/**
 * Check integrity
 */
RoomController.prototype.checkIntegrity = function()
{
    for (var player, i = this.room.players.items.length - 1; i >= 0; i--) {
        player = this.room.players.items[i];
        if (!player.client || !this.clients.exists(player.client)) {
            console.error('"Lost" player removed.');
            this.removePlayer(player);
        }
    }
};

/**
 * Start launch
 */
RoomController.prototype.startLaunch = function()
{
    if (!this.launching) {
        this.launching = setTimeout(this.launch, this.room.launchTime);
        this.socketGroup.addEvent('room:launch:start');
    }
};

/**
 * Cancel launch
 */
RoomController.prototype.cancelLaunch = function()
{
    if (this.launching) {
        this.launching = clearTimeout(this.launching);
        this.socketGroup.addEvent('room:launch:cancel');
    }
};

/**
 * Launch
 */
RoomController.prototype.launch = function()
{
    if (this.launching) {
        this.launching = clearTimeout(this.launching);
    }

    // Ready-check: never start while a non-host player isn't ready.
    if (!this.othersReady()) {
        this.socketGroup.addEvent('room:launch:cancel');
        return;
    }

    this.room.newGame();
};

/**
 * Every player except the host's own is ready (the host starts instead of
 * readying). Kurver's ready-check for "Start now!".
 *
 * @return {Boolean}
 */
RoomController.prototype.othersReady = function()
{
    var master = this.roomMaster;

    return this.room.players.items.every(function (player) {
        return player.client === master || (player.ready && !player.client.away);
    });
};

/**
 * Names of the players whose connection is currently away
 *
 * @return {Array}
 */
RoomController.prototype.awayNames = function()
{
    return this.room.players.items.filter(function (player) {
        return player.client && player.client.away;
    }).map(function (player) { return player.name; });
};

/**
 * A countdown already running stops if someone is no longer ready (a player
 * un-readied, or a new not-ready player joined).
 */
RoomController.prototype.checkLaunch = function()
{
    if (this.launching && !this.othersReady()) {
        this.cancelLaunch();
    }
};

/**
 * Does this account hold a seat (a player) in the room?
 *
 * @param {Number} userId
 *
 * @return {Boolean}
 */
RoomController.prototype.hasSeat = function(userId)
{
    return userId ? this.room.players.match(function () { return this.client && this.client.userId === userId; }) !== null : false;
};

/**
 * The account behind a new connection already has a seat here (it dropped,
 * reloaded, or opened the match again): the new connection takes the seat
 * over — same player, same ready state, host role kept — and the old
 * connection is retired. Mirrors FIFA's account-owned seats.
 *
 * @param {SocketClient} client
 */
RoomController.prototype.takeOverSeat = function(client)
{
    if (!client.userId) { return; }

    var old = this.clients.match(function () { return this !== client && this.userId === client.userId; });

    if (!old) { return; }

    var wasMaster = this.roomMaster === old,
        player, i;

    if (this.room.game) {
        // Mid-game the old connection is out of this game, exactly as a
        // disconnect always was; the seat comes back for the next one.
        this.room.game.controller.detach(old);
    }

    if (wasMaster) {
        this.releaseRoomMaster();
    }

    this.kickManager.removeClient(old);

    for (i = old.players.items.length - 1; i >= 0; i--) {
        player = old.players.items[i];
        old.players.remove(player);
        player.client = client;
        client.players.add(player);
        this.socketGroup.addEvent('player:client', {player: player.id, client: client.id});
    }

    this.clients.remove(old);
    this.detachEvents(old);
    this.socketGroup.addEvent('client:remove', old.id);

    if (old.connected) {
        old.addEvent('room:superseded', {message: 'You opened this match somewhere else.'});
    }

    if (wasMaster) {
        this.setRoomMaster(client);
    } else {
        this.nominateRoomMaster();
    }

    console.info('Account %s took its seat back in room "%s".', client.userId, this.room.name);
};

/**
 * Show a connection as away / back
 *
 * @param {SocketClient} client
 * @param {Boolean} away
 */
RoomController.prototype.setAway = function(client, away)
{
    if ((client.away ? true : false) === away) { return; }

    client.away      = away;
    client.awaySince = away ? Date.now() : null;

    this.socketGroup.addEvent('client:away', {client: client.id, away: away});

    if (away) {
        this.checkLaunch();
    }
};

/**
 * Presence check (every 2 s): quiet connections show as away, an away host
 * hands over, an away seat is released once the hold runs out.
 */
RoomController.prototype.sweep = function()
{
    var now = Date.now(),
        clients = this.clients.items.slice(),
        client, quiet, i;

    for (i = clients.length - 1; i >= 0; i--) {
        client = clients[i];

        if (!client.userId || !this.clients.exists(client)) { continue; }

        quiet = !client.connected || (now - (client.lastSeen || 0)) > this.awayAfter;

        if (quiet !== (client.away ? true : false)) {
            this.setAway(client, quiet);
        }

        if (client.away && now - client.awaySince > this.seatHold) {
            console.info('Seat of account %s released in room "%s".', client.userId, this.room.name);
            this.detach(client);
        }
    }

    if (this.roomMaster && this.roomMaster.away && now - this.roomMaster.awaySince > this.hostHandoffAfter &&
        this.clients.match(function () { return !this.away && this.active && this.isPlaying(); })) {
        this.removeRoomMaster();
    }
};

// Events:

/**
 * On client leave
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onLeave = function(client)
{
    this.detach(client);
};

/**
 * On client connection closed: a player with a seat keeps it (shown as away)
 * and can come back; anyone else just leaves.
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onDrop = function(client)
{
    if (!client.userId || !client.isPlaying() || !this.clients.exists(client)) {
        return this.detach(client);
    }

    if (this.room.game) {
        // Same as before for the game in progress: the dropped player's
        // line is out of this game.
        this.room.game.controller.detach(client);
    }

    this.setAway(client, true);
};

/**
 * On client clear players
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onPlayersClear = function(client)
{
    for (var i = client.players.items.length - 1; i >= 0; i--) {
        this.removePlayer(client.players.items[i]);
    }
};

/**
 * On client activity change
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onActivity = function(client)
{
    this.socketGroup.addEvent('client:activity', {
        client: client.id,
        active: client.active
    });
};

/**
 * On add player to room
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onPlayerAdd = function(client, data, callback)
{
    // Identity comes from the tenten.run login (set on the socket at connect),
    // never from the client: one player per account, named after the account.
    if (!client.userId) {
        return callback({success: false, error: 'Log in on tenten.run to play.'});
    }

    if (client.players.count() > 0) {
        return callback({success: false, error: 'One player per account.'});
    }

    if (this.room.players.match(function () { return this.client.userId === client.userId; })) {
        return callback({success: false, error: 'Your account is already in this room.'});
    }

    var name = String(client.displayName || 'Player').substr(0, Player.prototype.maxLength).trim(),
        color = typeof(data.color) !== 'undefined' ? data.color : null;

    if (name.length && !this.room.isNameAvailable(name)) {
        name = (name.substr(0, Player.prototype.maxLength - 7) + ' #' + client.userId).substr(0, Player.prototype.maxLength);
    }

    if (!name.length) {
        return callback({success: false, error: 'Invalid name.'});
    }

    if (this.room.game) {
        return callback({success: false, error: 'Game already started.'});
    }

    if (!this.room.isNameAvailable(name)) {
        return callback({success: false, error: 'This username is already used.'});
    }

    if (!this.clients.exists(client)) {
        console.error('Unknown client.');
        return callback({success: false, error: 'Unknown client'});
    }

    var player = new Player(client, name, color);

    if (this.room.addPlayer(player)) {
        client.players.add(player);
        this.emit('player:add', { room: this.room, player: player});
        callback({success: true});
        this.nominateRoomMaster();
    } else {
        return callback({success: false, error: 'Could not add player.'});
    }
};

/**
 * On remove player from room
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onPlayerRemove = function(client, data, callback)
{
    var player = client.players.getById(data.player);

    if (player) {
        this.removePlayer(player);
        this.emit('player:remove', { room: this.room, player: player});
    }

    callback({success: player ? true : false});
};

/**
 * On talk
 *
 * @param {SocketClient} client
 * @param {String} content
 * @param {Function} callback
 */
RoomController.prototype.onTalk = function(client, content, callback)
{
    var message = new Message(client, content.substr(0, Message.prototype.maxLength)),
        success = this.chat.addMessage(message);

    callback({success: success});

    if (success) {
        this.socketGroup.addEvent('room:talk', message.serialize());
    }
};

/**
 * On player change color
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onColor = function(client, data, callback)
{
    var player = client.players.getById(data.player),
        color = data.color;

    if (!player) {
        return callback({success: false});
    }

    if (player.setColor(color)) {
        callback({success: true, color: player.color});
        this.socketGroup.addEvent('player:color', { player: player.id, color: player.color });
    } else {
        callback({success: false, color: player.color});
    }
};

/**
 * On player change name
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onName = function(client, data, callback)
{
    var player = client.players.getById(data.player),
        name = data.name.substr(0, Player.prototype.maxLength).trim();

    if (!player) {
        return callback({success: false, error: 'Unknown player: "' + name + '"'});
    }

    if (client.userId) {
        return callback({success: false, error: 'Your name is your tenten.run account name.', name: player.name});
    }

    if (!name.length) {
        return callback({success: false, error: 'Invalid name.', name: player.name});
    }

    if (!this.room.isNameAvailable(name)) {
        return callback({success: false, error: 'This username is already used.', name: player.name});
    }

    player.setName(name);
    callback({success: true, name: player.name});
    this.socketGroup.addEvent('player:name', { player: player.id, name: player.name });
};

/**
 * On player ready
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onReady = function(client, data, callback)
{
    var player = client.players.getById(data.player);

    if (player) {
        // Ready is one-way for everyone but the host: the first press sets it
        // (a repeat press can't un-ready), and it is always re-broadcast.
        if (client === this.roomMaster) {
            player.toggleReady();
        } else {
            player.toggleReady(true);
        }

        callback({success: true, ready: player.ready});
        this.socketGroup.addEvent('player:ready', { player: player.id, ready: player.ready });

        if (this.room.isReady()) {
            this.launch();
        } else {
            this.checkLaunch();
        }
    } else {
        callback({success: false, error: 'Player with id "' + data.player + '" not found'});
    }
};

/**
 * On kick vote
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onKickVote = function(client, data, callback)
{
    // Only the host can remove players (Kurver's vote-kick for other players
    // is turned off), and never one of their own.
    if (!this.isRoomMaster(client)) {
        return callback({success: false, kicked: false, error: 'Only the host can remove players.'});
    }

    var player = this.room.players.getById(data.player);

    if (!player) {
        return callback({success: false, kicked: false, error: 'Player not found.'});
    }

    if (player.client === client) {
        return callback({success: false, kicked: false, error: "You can't remove yourself."});
    }

    this.onKick(player);

    return callback({success: true, kicked: true});
};

/**
 * On config open
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onConfigOpen = function(client, data, callback)
{
    var success = this.isRoomMaster(client) && this.room.config.setOpen(data.open);

    callback({
        success: success,
        open: this.room.config.open,
        password: this.room.config.password
    });

    if (success) {
        this.socketGroup.addEvent('room:config:open', {
            open: this.room.config.open,
            password: this.room.config.password
        });
    }
};

/**
 * On config max score
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onConfigMaxScore = function(client, data, callback)
{
    var success = this.isRoomMaster(client) && this.room.config.setMaxScore(data.maxScore);

    callback({success: success, maxScore: this.room.config.maxScore });

    if (success) {
        this.socketGroup.addEvent('room:config:max-score', { maxScore: this.room.config.maxScore });
    }
};

/**
 * On config speed
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onConfigVariable = function(client, data, callback)
{
    var success = this.isRoomMaster(client) && this.room.config.setVariable(data.variable, data.value);

    callback({success: success, value: this.room.config.getVariable(data.variable) });

    if (success) {
        this.socketGroup.addEvent('room:config:variable', {
            variable: data.variable,
            value: this.room.config.getVariable(data.variable)
        });
    }
};

/**
 * On config bonus
 *
 * @param {SocketClient} client
 * @param {Object} data
 * @param {Function} callback
 */
RoomController.prototype.onConfigBonus = function(client, data, callback)
{
    var success = this.isRoomMaster(client) && this.room.config.toggleBonus(data.bonus);

    callback({success: success, enabled: this.room.config.getBonus(data.bonus) });

    if (success) {
        this.socketGroup.addEvent('room:config:bonus', {
            bonus: data.bonus,
            enabled: this.room.config.getBonus(data.bonus)
        });
    }
};

/**
 * On launch
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onLaunch = function(client)
{
    if (this.isRoomMaster(client)) {
        if (this.launching) {
            this.cancelLaunch();
        } else if (this.othersReady()) {
            this.startLaunch();
        } else {
            var away = this.awayNames();
            client.addEvent('room:launch:refused', {error: away.length ? 'Waiting for ' + away.join(', ') + ' to come back.' : 'Waiting for every player to be ready.'});
        }
    }
};

/**
 * On player join
 *
 * @param {Object} data
 */
RoomController.prototype.onPlayerJoin = function(data)
{
    this.socketGroup.addEvent('room:join', {player: data.player.serialize()});
    this.checkLaunch();
};

/**
 * On player leave
 *
 * @param {Object} data
 */
RoomController.prototype.onPlayerLeave = function(data)
{
    this.socketGroup.addEvent('room:leave', {player: data.player.id});

    if (this.room.isReady()) {
        this.launch();
    }
};

/**
 * Warmup room
 *
 * @param {Room} room
 */
RoomController.prototype.onGame = function()
{
    this.socketGroup.addEvent('room:game:start');
};

/**
 * On kick
 *
 * @param {Player} player
 */
RoomController.prototype.onKick = function(player)
{
    var client = player.client;

    this.socketGroup.addEvent('room:kick', player.id);
    this.removePlayer(player);

    // Removed by the host: the whole connection leaves the room (all of its
    // players), is told why, and that account can't join this room again.
    if (client && client !== this.roomMaster && this.clients.exists(client)) {
        if (client.userId) {
            this.room.kickedUserIds = this.room.kickedUserIds || [];
            if (this.room.kickedUserIds.indexOf(client.userId) < 0) { this.room.kickedUserIds.push(client.userId); }
        }
        client.addEvent('room:kicked', {message: 'You were removed by the host'});
        this.detach(client);
    }
};

/**
 * On new vote
 *
 * @param {kickVote} kickVote
 */
RoomController.prototype.onVoteNew = function(kickVote)
{
    this.socketGroup.addEvent('vote:new', kickVote.serialize());
};

/**
 * On vote close
 *
 * @param {kickVote} kickVote
 */
RoomController.prototype.onVoteClose = function(kickVote)
{
    this.socketGroup.addEvent('vote:close', kickVote.serialize());
};
