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
    // Rematch: offered once a game has ended and its credit is done
    // (rematchAvailable); pending once someone pressed ({by: [userId…]}).
    this.rematch          = null;
    this.rematchAvailable = false;
    // Accounts whose line left the game in progress (dropped / reloaded), and
    // the result to tell them once it ends ({userIds: [], message}) — kept
    // until they're back or the next game starts.
    this.leftThisGame     = [];
    this.leftResult       = null;
    this.lastWinnerName   = null;

    this.onPlayerJoin     = this.onPlayerJoin.bind(this);
    this.onPlayerLeave    = this.onPlayerLeave.bind(this);
    this.onGame           = this.onGame.bind(this);
    this.onGameEnd        = this.onGameEnd.bind(this);
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
        onLaunch: function (data) { controller.onLaunch(this); },
        onRematch: function () { controller.onRematch(this); },
        // Only the current host's own Leave hands the role on (a stale call
        // from a host already replaced must not unseat the new one).
        onMasterLeave: function () { if (controller.roomMaster === this) { controller.removeRoomMaster(); } }
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
    this.room.on('game:end', this.onGameEnd);
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
    this.room.removeListener('game:end', this.onGameEnd);
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
        this.deliverLeftResult();
        callback({
            success: true,
            room: this.room.serialize(),
            master: this.roomMaster ? this.roomMaster.id : null,
            clients: this.clients.map(function () { return this.serialize(); }).items,
            messages: this.chat.serialize(100),
            votes: this.kickManager.votes.map(function () { return this.serialize(); }).items,
            rematch: this.serializeRematch()
        });
        this.sendPayPrompt(client);
        client.addEvent('room:fees', {on: KurverPay.entryFeesRequested()});
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
    if (this.rematch && this.clients.exists(client) && client.isPlaying()) {
        this.cancelRematch(this.clientName(client) + ' left — rematch cancelled.');
    }

    if (this.clients.remove(client)) {
        if (this.room.game) {
            this.room.game.controller.detach(client);
        }

        client.clearPlayers();
        this.detachEvents(client);
        this.promptCheckForClose();
        this.socketGroup.addEvent('client:remove', client.id);
        this.emit('client:remove', { room: this.room, client: client});

        // The room never keeps a host who is no longer in it (seat released,
        // Leave, kick): the role goes to someone who is.
        if (this.roomMaster === client) {
            this.removeRoomMaster();
        } else if (!this.roomMaster) {
            this.nominateRoomMaster();
        }
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
    client.on('room:rematch', this.callbacks.onRematch);
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
    client.removeListener('room:rematch', this.callbacks.onRematch);
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

    // A player who is here (idle or not) first; failing that, any seated
    // player — the room always has a host while it has players.
    var roomMaster = this.clients.match(function () { return !this.away && this.isPlaying(); }) ||
                     this.clients.match(function () { return this.isPlaying(); });

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
        this.roomMaster.on('room:leave', this.callbacks.onMasterLeave);
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
    var old = this.roomMaster;

    if (old) {
        this.releaseRoomMaster();
        this.nominateRoomMaster();
        this.onHostPassed(old);
    }
};

/**
 * The host role went from one account to another: everyone's Ready is
 * cleared (they re-accept with the new host) and the chat says who hosts now.
 *
 * @param {SocketClient} old
 */
RoomController.prototype.onHostPassed = function(old)
{
    var master = this.roomMaster;

    if (!master || master === old || (master.userId && master.userId === old.userId)) { return; }

    if (!this.room.game) {
        this.clearReady();
    }

    this.systemLine(this.clientName(master) + ' is now the host');
};

/**
 * Drop the current game master without nominating a new one
 */
RoomController.prototype.releaseRoomMaster = function()
{
    if (this.roomMaster) {
        this.roomMaster.removeListener('room:leave', this.callbacks.onMasterLeave);
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

    // Ready-check: never start while a player isn't ready, nor while a
    // rematch is waiting for everyone.
    if (this.rematch || !this.canStart()) {
        this.socketGroup.addEvent('room:launch:cancel');
        return;
    }

    // Entry fees on: a game only starts once every entry is paid (READY = pay).
    if (KurverPay.entryFeesRequested()) { return; }

    this.room.newGame();
};

/**
 * Can "Start now!" start? At least minPlayers in the room (one player per
 * account), and every non-host player ready (and here).
 *
 * @return {Boolean}
 */
RoomController.prototype.canStart = function()
{
    return this.room.players.count() >= this.minPlayers && this.othersReady();
};

/**
 * Kurver is a 3+ player game: no match starts with fewer in the room.
 *
 * @type {Number}
 */
RoomController.prototype.minPlayers = 3;

/**
 * Entry fees (kurver-pay.js): after the host's Start every player pays the
 * flat $2 on Stripe's page; the payment counts when Stripe's webhook confirms
 * it. When all have paid, the game starts as soon as everyone is back on the
 * page (at most returnGrace later — a player still away then plays from away,
 * which loses, as any drop does). When the game can't happen through no
 * fault of a payer (someone didn't pay in time / left first, a system error)
 * their entry becomes Refund Balance — nothing is ever refunded to a card.
 *
 * @type {Number}
 */
RoomController.prototype.returnGrace = Number(process.env.KURVER_PAY_RETURN_GRACE_MS) || 60000;

/**
 * Open the payment window for the players in the room now (the first READY
 * with entry fees on): no one can join or be kicked until it closes; every
 * player has PAY_WINDOW_MS (3 min) to press READY and pay — if anyone doesn't,
 * every entry paid becomes Refund Balance.
 *
 * @return {Object} the window
 */
RoomController.prototype.openPaymentWindow = function()
{
    if (this.payment) { return this.payment; }
    var controller = this,
        players = this.room.players.items.slice(),
        pot = KurverMoney.prize(players.length),
        pw = {
            attemptId: 'kurver-' + this.room.code + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
            pot: pot,
            deadline: Date.now() + KurverPay.PAY_WINDOW_MS,
            urls: {},
            paid: {},
            userIds: players.map(function (p) { return p.client.userId; }),
            timer: null,
            returnTimer: null,
            allPaid: false,
            closing: false
        };

    this.payment = pw;
    KurverPay.watchAttempt(pw.attemptId, function (row) { return controller.paymentConfirmed(row); });
    pw.timer = setTimeout(function () {
        var waiting = controller.payNames(false);
        controller.cancelPaymentWindow((waiting.join(', ') || 'A player') + ' didn\'t pay in time', 'payment_timeout');
    }, KurverPay.PAY_WINDOW_MS);
    var secs = Math.round(KurverPay.PAY_WINDOW_MS / 1000),
        clock = Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2);
    console.info('[entry-fees] room "%s": payment window %s — $2 each, %d players, $%d pot', this.room.name, pw.attemptId, players.length, pot);
    this.systemLine('Entry $2 each — ' + players.length + ' players, $' + pot + ' pot. Everyone has ' + clock + ' to press READY and pay — if anyone doesn\'t, every entry paid is refunded to the payer\'s Refund Balance.');
    this.sendPayPrompts();
    return pw;
};

/**
 * READY with entry fees on: open the window if there isn't one, then send
 * this player straight to their own Stripe Checkout (flat $2, server-side —
 * nothing from the page). Pressing READY again reuses it. The player shows
 * as ready once Stripe's webhook confirms the payment.
 *
 * @param {SocketClient} client
 * @param {Player} player
 * @param {Function} callback
 */
RoomController.prototype.readyToPay = function(client, player, callback)
{
    var controller = this, uid = client.userId, pw;

    if (!KurverPay.entryFeesReady()) {
        client.addEvent('kurver:notice', {message: 'Payments are unavailable right now — try again later.'});
        return callback({success: false, error: 'Payments are unavailable right now.', ready: false});
    }
    if (this.room.game) { return callback({success: false, error: 'Game already started.', ready: player.ready}); }
    if (!this.payment && this.room.players.count() < this.minPlayers) {
        client.addEvent('kurver:notice', {message: 'Need at least ' + this.minPlayers + ' players to start.'});
        return callback({success: false, error: 'Need at least ' + this.minPlayers + ' players to start.', ready: false});
    }

    pw = this.openPaymentWindow();
    if (pw.closing || pw.userIds.indexOf(uid) < 0) { return callback({success: false, ready: player.ready}); }
    if (pw.paid[uid]) {
        this.sendPayPrompt(client);
        return callback({success: true, ready: true});
    }
    callback({success: true, ready: false, paying: true});

    var go = function () {
        var payload = controller.payPayload(uid);
        if (payload) { payload.go = true; client.addEvent('room:pay', payload); }
    };
    if (pw.urls[uid]) { return go(); }

    // One READY at a time per player: a second tap while the first is still
    // being handled does nothing.
    this.payingNow = this.payingNow || {};
    if (this.payingNow[uid]) { return; }
    this.payingNow[uid] = true;
    var done = function () { delete controller.payingNow[uid]; };

    // Refund Balance covers the whole $2? Then it pays — nothing charged to the
    // card. Less than $2: credit untouched, card as normal.
    KurverPay.payWithCredit({
        game: 'kurver', attemptId: pw.attemptId, userId: uid,
        amountCents: KurverPay.ENTRY_CENTS, prize: pw.pot.toFixed(2)
    }).then(function (byCredit) {
        if (!byCredit) { return controller.payByCard(client, pw, uid, go); }
        if (controller.payment !== pw || pw.closing || !controller.paymentConfirmed(byCredit)) {
            return KurverPay.creditRow(byCredit, 'attempt_gone');   // window closed meanwhile: the credit goes back
        }
        client.addEvent('room:pay:credit', {message: 'Entry $2.00 — paid from your Refund Balance.'});
    }).then(done, done);
};

/**
 * Open this player's Stripe Checkout (flat $2) and send their page to it.
 *
 * @param {SocketClient} client
 * @param {Object} pw
 * @param {Number} uid
 * @param {Function} go
 */
RoomController.prototype.payByCard = function(client, pw, uid, go)
{
    var controller = this;
    var base = String(process.env.BASE_URL || '').replace(/\/$/, '');
    return KurverPay.openPayment({
        game: 'kurver', attemptId: pw.attemptId, userId: uid,
        amountCents: KurverPay.ENTRY_CENTS, prize: pw.pot.toFixed(2),
        productName: 'Kurver entry — ' + pw.userIds.length + ' players, $' + pw.pot + ' pot',
        successUrl: base + '/multiplayer?paid=1', cancelUrl: base + '/multiplayer?paid=0'
    }).then(function (out) {
        if (controller.payment !== pw || pw.closing || !out.url) { return; }
        pw.urls[uid] = out.url;
        go();
    }).catch(function (error) {
        console.error('[entry-fees] couldn\'t open a Checkout in room "%s":', controller.room.name, error);
        controller.cancelPaymentWindow('Payments are unavailable right now — try again', 'system_error');
    });
};

/**
 * Names of the players who have (true) / haven't (false) paid.
 *
 * @param {Boolean} paid
 *
 * @return {Array}
 */
RoomController.prototype.payNames = function(paid)
{
    var pw = this.payment;
    if (!pw) { return []; }
    return this.room.players.items.filter(function (p) {
        return (pw.paid[p.client.userId] ? true : false) === paid;
    }).map(function (p) { return p.name; });
};

/**
 * What one player's page shows while entries are being paid.
 *
 * @param {Number} userId
 *
 * @return {Object|null}
 */
RoomController.prototype.payPayload = function(userId)
{
    var pw = this.payment;
    if (!pw || pw.closing) { return null; }
    var mine = pw.paid[userId] ? true : false;
    return {
        entry: '2.00', pot: pw.pot, players: pw.userIds.length, deadline: pw.deadline,
        paid: mine, url: mine ? null : (pw.urls[userId] || null),
        waiting: this.room.players.items.filter(function (p) { return !pw.paid[p.client.userId] && p.client.userId !== userId; }).map(function (p) { return p.name; }),
        allPaid: pw.allPaid
    };
};

/**
 * Send one connection its payment state (players only).
 *
 * @param {SocketClient} client
 */
RoomController.prototype.sendPayPrompt = function(client)
{
    if (!this.payment || !client.userId || this.payment.userIds.indexOf(client.userId) < 0) { return; }
    var payload = this.payPayload(client.userId);
    if (payload) { client.addEvent('room:pay', payload); }
};

/**
 * Send every player's page its payment state.
 */
RoomController.prototype.sendPayPrompts = function()
{
    for (var i = this.room.players.items.length - 1; i >= 0; i--) {
        this.sendPayPrompt(this.room.players.items[i].client);
    }
};

/**
 * Stripe's webhook confirmed a payment for this room's attempt. false = it
 * can't be used (the caller turns it into Refund Balance).
 *
 * @param {Object} row
 *
 * @return {Boolean}
 */
RoomController.prototype.paymentConfirmed = function(row)
{
    var pw = this.payment, controller = this;
    if (row.game !== 'kurver' || !pw || pw.closing || pw.attemptId !== row.attempt_id || pw.userIds.indexOf(row.user_id) < 0) { return false; }
    if (!this.room.players.match(function () { return this.client && this.client.userId === row.user_id; })) { return false; }
    pw.paid[row.user_id] = true;
    var paidPlayer = this.room.players.match(function () { return this.client && this.client.userId === row.user_id; });
    if (paidPlayer && !paidPlayer.ready) {
        paidPlayer.toggleReady(true);                  // the ready tick = payment confirmed by Stripe
        this.socketGroup.addEvent('player:ready', { player: paidPlayer.id, ready: true });
    }
    if (pw.userIds.every(function (id) { return pw.paid[id]; })) {
        pw.allPaid = true;
        if (pw.timer) { clearTimeout(pw.timer); pw.timer = null; }
        pw.returnBy = Date.now() + this.returnGrace;
        pw.returnTimer = setInterval(function () { controller.startPaidGameWhenBack(); }, 1000);
        this.systemLine('Everyone has paid — the game starts as soon as all players are back.');
    }
    this.sendPayPrompts();
    if (pw.allPaid) { this.startPaidGameWhenBack(); }
    return true;
};

/**
 * All paid: start once every player is back on the page, or when the grace
 * runs out (a player still away plays from away — that loses, as any drop).
 */
RoomController.prototype.startPaidGameWhenBack = function()
{
    var pw = this.payment;
    if (!pw || !pw.allPaid || pw.closing) { return; }
    var allBack = this.room.players.items.every(function (p) { return p.client && p.client.connected && !p.client.away; });
    if (!allBack && Date.now() < pw.returnBy) { return; }
    pw.closing = true;
    if (pw.returnTimer) { clearInterval(pw.returnTimer); pw.returnTimer = null; }
    KurverPay.unwatchAttempt(pw.attemptId);
    this.payment = null;
    var game = this.room.newGame(), controller = this;
    if (!game) {
        console.error('[entry-fees] room "%s": game couldn\'t be started after all paid — entries become Refund Balance', this.room.name);
        KurverPay.attemptRows(pw.attemptId).then(function (rows) {
            return Promise.all(rows.filter(function (r) { return r.status === 'paid' && !r.match_key; })
                .map(function (r) { return KurverPay.creditRow(r, 'match_start_failed').then(function (ok) { return ok ? r.user_id : null; }); }));
        }).catch(function (e) { console.error('[entry-fees] Refund Balance failed — the recovery sweep will retry:', e); return []; })
          .then(function (ids) { controller.tellNoFault('The game couldn\'t be started', 'match_start_failed', (ids || []).filter(Boolean)); });
        return;
    }
    // The pot is what was paid for: every paid entry except one, even if a
    // player who paid left before the start.
    var paidCount = pw.userIds.length;
    game.prizeDollars = KurverMoney.prize(paidCount);
    KurverPay.attachMatch(pw.attemptId, 'kurver:' + game.gameKey, 'Kurver').catch(function (e) {
        console.error('[entry-fees] couldn\'t attach %s to game %s:', pw.attemptId, game.gameKey, e);
    });
    console.info('[entry-fees] room "%s": all %d paid — game %s started ($%d pot)', controller.room.name, paidCount, game.gameKey, game.prizeDollars);
};

/**
 * The window ends without a game: unpaid Checkouts closed; anyone who paid
 * gets it as Refund Balance (the game couldn't happen through no fault of theirs).
 *
 * @param {String} message
 * @param {String} reason
 */
RoomController.prototype.cancelPaymentWindow = function(message, reason)
{
    var pw = this.payment, controller = this;
    if (!pw || pw.closing) { return; }
    pw.closing = true;
    if (pw.timer) { clearTimeout(pw.timer); }
    if (pw.returnTimer) { clearInterval(pw.returnTimer); }
    KurverPay.unwatchAttempt(pw.attemptId);
    this.payment = null;
    for (var i = this.room.players.items.length - 1; i >= 0; i--) {
        var player = this.room.players.items[i];
        if (player.ready) {
            player.toggleReady(false);
            this.socketGroup.addEvent('player:ready', { player: player.id, ready: false });
        }
    }
    KurverPay.cancelAttempt(pw.attemptId, reason).then(function (out) {
        return out.credited;
    }).catch(function (e) {
        console.error('[entry-fees] cancelling %s failed — the recovery sweep will turn any payment into Refund Balance:', pw.attemptId, e);
        return [];
    }).then(function (credited) {
        console.info('[entry-fees] room "%s": window %s cancelled (%s)', controller.room.name, pw.attemptId, reason);
        controller.tellNoFault(message, reason, credited);
    });
};

/**
 * Tell the room a payment window ended without a game: a player who paid
 * hears about their Refund Balance (a perk, never a refund); everyone else just
 * that the game didn't start.
 *
 * @param {String} message
 * @param {String} reason
 * @param {Array} credited  user ids whose entry became Refund Balance
 */
RoomController.prototype.tellNoFault = function(message, reason, credited)
{
    var why = {
            payment_timeout: 'Not everyone paid, so the game was cancelled.',
            left_before_start: 'A player left before paying, so the game was cancelled.',
            match_start_failed: 'The game couldn\'t start, so it was cancelled.',
            system_error: 'The game couldn\'t start, so it was cancelled.'
        }[reason] || 'The game couldn\'t start, so it was cancelled.',
        // what a player who wasn't refunded hears (in a timeout: one who didn't pay)
        other = {
            payment_timeout: 'You didn\'t pay in time — the game didn\'t start.',
            left_before_start: 'A player left — the game didn\'t start.',
            match_start_failed: 'The game couldn\'t start.',
            system_error: 'The game couldn\'t start.'
        }[reason] || message + ' — the game didn\'t start.',
        watching = message + ' — the game didn\'t start.';
    this.systemLine(watching + (credited.length ? ' Any entry paid has been refunded to that player\'s Refund Balance.' : ''));
    for (var i = this.clients.items.length - 1; i >= 0; i--) {
        var client = this.clients.items[i];
        client.addEvent('room:pay:cancelled', {
            message: client.userId && credited.indexOf(client.userId) >= 0
                ? why + ' Your $2.00 has been refunded to your Refund Balance — use it to enter another game at the same price.'
                : (client.isPlaying() ? other : watching)
        });
    }
};

/**
 * Clear everyone's Ready (the host role passed to someone else) and stop a
 * countdown that's running.
 */
RoomController.prototype.clearReady = function()
{
    for (var player, i = this.room.players.items.length - 1; i >= 0; i--) {
        player = this.room.players.items[i];
        if (player.ready) {
            player.toggleReady(false);
            this.socketGroup.addEvent('player:ready', { player: player.id, ready: false });
        }
    }

    this.cancelLaunch();
};

/**
 * A line the room itself writes into the chat (kept in its history).
 *
 * @param {String} content
 */
RoomController.prototype.systemLine = function(content)
{
    var line = {
        id: null,
        client: {id: null},
        content: content,
        creation: new Date(),
        serialize: function () { return {client: null, content: this.content, creation: this.creation.getTime(), system: true}; }
    };

    this.chat.messages.add(line);
    this.socketGroup.addEvent('room:talk', line.serialize());
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
    if (this.launching && !this.canStart()) {
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

    // The connection holding the seat (with players), else any older one.
    var old = this.clients.match(function () { return this !== client && this.userId === client.userId && this.isPlaying(); }) ||
              this.clients.match(function () { return this !== client && this.userId === client.userId; });

    if (!old) { return; }

    // Opened again (new tab / device) while still playing the running game
    // on a live connection: don't pull that game away from it. This one
    // watches; it takes the seat when the game ends, or if the playing
    // connection drops (which loses the game, as any drop does).
    if (this.room.game && old.connected && !old.away && old.isPlaying() && this.room.game.controller.clients.exists(old)) {
        client.pendingSeat = true;
        client.addEvent('kurver:notice', {message: 'You\'re already playing in another tab. This tab is watching; it takes your seat when the game ends.'});
        return;
    }

    client.pendingSeat = false;

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

        if (client.away && now - client.awaySince > this.seatHold && !this.payment) {
            console.info('Seat of account %s released in room "%s".', client.userId, this.room.name);
            this.detach(client);
        }
    }

    // A pending rematch can't wait on someone who is gone: away for 30 s
    // cancels it (their seat is kept, as always).
    if (this.rematch) {
        var gone = this.room.players.match(function () { return this.client && this.client.away && now - this.client.awaySince > 30000; });
        if (gone) { this.cancelRematch(gone.name + ' is away — rematch cancelled.'); }
    }

    if (this.roomMaster && this.roomMaster.away && now - this.roomMaster.awaySince > this.hostHandoffAfter && !this.payment &&
        this.clients.match(function () { return !this.away && this.isPlaying(); })) {
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

    // The last player pressed Leave: the room closes now (as FIFA) and leaves
    // everyone's list at once. An emptied room after a drop still waits
    // timeToClose (promptCheckForClose).
    if (this.clients.isEmpty()) {
        this.checkForClose();
    }
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
        if (this.room.game.controller.clients.exists(client) && this.leftThisGame.indexOf(client.userId) < 0) {
            this.leftThisGame.push(client.userId);
        }
        this.room.game.controller.detach(client);
    }

    this.setAway(client, true);

    // Another tab of this account was waiting for the seat: it takes it now.
    var waiting = this.clients.match(function () { return this.pendingSeat && this.userId === client.userId && this.connected; });
    if (waiting) {
        this.takeOverSeat(waiting);
    }
};

/**
 * Tell players whose line left the game (dropped / reloaded mid-game) how it
 * ended, on whichever connection of theirs is here now. Display only.
 */
RoomController.prototype.deliverLeftResult = function()
{
    var result = this.leftResult,
        controller = this;

    if (!result || !result.userIds.length) { return; }

    result.userIds = result.userIds.filter(function (userId) {
        var client = controller.clients.match(function () { return this.userId === userId && this.connected && this.isPlaying(); });
        if (!client) { return true; }
        client.addEvent('kurver:notice', {message: result.message});
        return false;
    });
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

    if (this.payment) {
        return callback({success: false, error: 'This game is starting — entries are being paid.'});
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

    if (player && this.rematch) {
        return callback({success: false, error: 'Waiting for everyone to accept the rematch.', ready: player.ready});
    }

    // Entry fees on: READY is paying (the tick comes with Stripe's confirmation).
    if (player && KurverPay.entryFeesRequested()) {
        return this.readyToPay(client, player, callback);
    }

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

    if (this.payment) {
        return callback({success: false, kicked: false, error: 'Not while entries are being paid.'});
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
    if (this.isRoomMaster(client) && this.rematch) {
        return client.addEvent('room:launch:refused', {error: 'Waiting for everyone to accept the rematch.'});
    }

    if (this.isRoomMaster(client) && (this.payment || KurverPay.entryFeesRequested())) {
        return client.addEvent('room:launch:refused', {error: 'The game starts as soon as everyone has paid (READY).'});
    }

    if (this.isRoomMaster(client)) {
        if (this.launching) {
            this.cancelLaunch();
        } else if (this.canStart()) {
            if (KurverPay.entryFeesRequested()) {
                // Entry fees: each player's READY is their $2; the game starts
                // by itself once everyone has paid.
                return client.addEvent('room:launch:refused', {error: 'The game starts as soon as everyone has paid (READY).'});
            }
            this.startLaunch();
        } else {
            var away = this.awayNames();
            client.addEvent('room:launch:refused', {error: this.room.players.count() < this.minPlayers ? 'Need at least ' + this.minPlayers + ' players to start.'
                : away.length ? 'Waiting for ' + away.join(', ') + ' to come back.'
                : 'Waiting for every player to be ready.'});
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

    // Entries being collected: the game can't happen as it was paid for —
    // the window closes and anyone who paid gets Refund Balance. (Once every entry
    // is paid, a player who leaves just loses theirs.)
    if (this.payment && !this.payment.allPaid) {
        this.cancelPaymentWindow(data.player.name + ' left before the game started', 'left_before_start');
    }

    // Below the minimum now? A running countdown stops (back to waiting).
    this.checkLaunch();

    // Not when the host has just left: the role passes first (and that
    // clears Ready), so whoever is left isn't thrown into a game at once.
    var master = this.roomMaster,
        hostHere = master && this.room.players.match(function () { return this.client === master; });

    if (this.room.isReady() && hostHere) {
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
    var controller = this,
        game = this.room.game;

    this.leftThisGame     = [];
    this.leftResult       = null;
    this.lastWinnerName   = null;
    if (game) {
        // First listener, so it runs before the room closes the game (game:end).
        game.prependOnceListener('end', function () { controller.lastWinnerName = game.gameWinner ? game.gameWinner.name : null; });
    }

    this.rematch          = null;
    this.rematchAvailable = false;
    this.socketGroup.addEvent('room:rematch', this.serializeRematch());
    this.socketGroup.addEvent('room:game:start');
};

/**
 * A game ended: a tab that was waiting for its account's seat takes it, and
 * players who left mid-game are told the result.
 */
RoomController.prototype.onGameEnd = function()
{
    var pending = this.clients.filter(function () { return this.pendingSeat; }).items,
        i;

    for (i = 0; i < pending.length; i++) {
        if (this.clients.exists(pending[i]) && pending[i].connected) {
            this.takeOverSeat(pending[i]);
        }
    }

    if (this.leftThisGame.length) {
        this.leftResult = {
            userIds: this.leftThisGame,
            message: this.lastWinnerName ? 'You left the game: ' + this.lastWinnerName + ' won.' : 'You left the game. It ended with no winner.'
        };
        this.leftThisGame = [];
        this.deliverLeftResult();
    }
};

/**
 * The game that just ended is decided and its credit done: offer a rematch.
 */
RoomController.prototype.offerRematch = function()
{
    if (this.room.game) { return; }

    this.rematchAvailable = true;
    this.socketGroup.addEvent('room:rematch', this.serializeRematch());
};

/**
 * A player pressed Rematch. The first press makes it pending (everyone is
 * sent back to the room chat); it only takes effect once every player in the
 * room has pressed — then ready states are cleared and the normal Ready /
 * Start flow runs again (a new game gets its own game key, so its credit is
 * separate from the previous game's).
 *
 * @param {SocketClient} client
 */
RoomController.prototype.onRematch = function(client)
{
    if (this.room.game || !this.rematchAvailable || !client.userId || !client.isPlaying()) { return; }

    if (!this.rematch) {
        this.rematch = {by: [client.userId]};
    } else if (this.rematch.by.indexOf(client.userId) < 0) {
        this.rematch.by.push(client.userId);
    }

    var by = this.rematch.by,
        players = this.room.players.items,
        everyone = players.length >= 2 && players.every(function (player) { return player.client && by.indexOf(player.client.userId) >= 0; }),
        i, player;

    if (!everyone) {
        this.socketGroup.addEvent('room:rematch', this.serializeRematch());
        return;
    }

    this.rematch          = null;
    this.rematchAvailable = false;

    for (i = players.length - 1; i >= 0; i--) {
        player = players[i];
        player.toggleReady(false);
        this.socketGroup.addEvent('player:ready', { player: player.id, ready: player.ready });
    }

    this.cancelLaunch();
    this.socketGroup.addEvent('room:rematch', this.serializeRematch({accepted: true}));
};

/**
 * Drop a pending rematch (someone left or is gone) and say why.
 *
 * @param {String} message
 */
RoomController.prototype.cancelRematch = function(message)
{
    if (!this.rematch) { return; }

    this.rematch = null;
    this.socketGroup.addEvent('room:rematch', this.serializeRematch({cancelled: message}));
};

/**
 * Name of a client's (first) player
 *
 * @param {SocketClient} client
 *
 * @return {String}
 */
RoomController.prototype.clientName = function(client)
{
    var player = client.players.items[0];

    return player ? player.name : 'A player';
};

/**
 * Rematch state as sent to clients
 *
 * @param {Object} extra
 *
 * @return {Object}
 */
RoomController.prototype.serializeRematch = function(extra)
{
    var by = this.rematch ? this.rematch.by : [],
        players = this.room.players.items,
        pressed = players.filter(function (player) { return player.client && by.indexOf(player.client.userId) >= 0; }),
        waiting = players.filter(function (player) { return !player.client || by.indexOf(player.client.userId) < 0; }),
        data = {
            available: this.rematchAvailable,
            pending: this.rematch ? true : false,
            by: pressed.map(function (player) { return player.id; }),
            names: pressed.map(function (player) { return player.name; }),
            waiting: waiting.map(function (player) { return player.name; })
        };

    if (extra) {
        for (var key in extra) { if (extra.hasOwnProperty(key)) { data[key] = extra[key]; } }
    }

    return data;
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
    if (this.rematch) { this.cancelRematch(player.name + ' left — rematch cancelled.'); }
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
