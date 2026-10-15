/**
 * Room Controller
 *
 * @param {Object} $scope
 * @param {Object} $routeParams
 * @param {Object} $location
 * @param {SocketClient} SocketClient
 * @param {RoomRepository} repository
 * @param {Profile} profile
 * @param {Chat} chat
 * @param {Notifier} notifier
 */
function RoomController($scope, $routeParams, $location, client, repository, profile, chat, notifier)
{
    AbstractController.call(this, $scope);

    document.body.classList.remove('game-mode');

    var search = $location.search();

    this.$location      = $location;
    this.$routeParams   = $routeParams;
    this.client         = client;
    this.profile        = profile;
    this.chat           = chat;
    this.notifier       = notifier;
    this.hasTouch       = typeof(window.ontouchstart) !== 'undefined';
    this.name           = decodeURIComponent($routeParams.name);
    this.password       = typeof(search.password) !== 'undefined' ? search.password : null;
    this.repository     = repository;
    this.controlSynchro = false;
    // Phones and tablets get the touch controls automatically.
    this.autoTouch      = this.hasTouch && RoomController.isTouchDevice();
    this.useTouch       = this.autoTouch;
    this.launchInterval = null;

    // Binding:
    this.addPlayer        = this.addPlayer.bind(this);
    this.addProfileUser   = this.addProfileUser.bind(this);
    this.removePlayer     = this.removePlayer.bind(this);
    this.kickPlayer       = this.kickPlayer.bind(this);
    this.onJoin           = this.onJoin.bind(this);
    this.onJoined         = this.onJoined.bind(this);
    this.onControlChange  = this.onControlChange.bind(this);
    this.joinRoom         = this.joinRoom.bind(this);
    this.leaveRoom        = this.leaveRoom.bind(this);
    this.setColor         = this.setColor.bind(this);
    this.setReady         = this.setReady.bind(this);
    this.setName          = this.setName.bind(this);
    this.setTouch         = this.setTouch.bind(this);
    this.updateProfile    = this.updateProfile.bind(this);
    this.toggleParameters = this.toggleParameters.bind(this);
    this.prizeLabel       = this.prizeLabel.bind(this);
    this.onRoomMaster     = this.onRoomMaster.bind(this);
    this.onConfigOpen     = this.onConfigOpen.bind(this);
    this.onLaunchStart    = this.onLaunchStart.bind(this);
    this.onLaunchTimer    = this.onLaunchTimer.bind(this);
    this.onLaunchCancel   = this.onLaunchCancel.bind(this);
    this.launch           = this.launch.bind(this);
    this.start            = this.start.bind(this);
    this.onPlayerClient   = this.onPlayerClient.bind(this);
    this.onSuperseded     = this.onSuperseded.bind(this);
    this.onRematch        = this.onRematch.bind(this);
    this.onPay            = this.onPay.bind(this);
    this.onFees           = this.onFees.bind(this);
    this.onPayCancelled   = this.onPayCancelled.bind(this);
    this.tickPay          = this.tickPay.bind(this);

    this.$scope.$on('$destroy', this.leaveRoom);

    // Hydrating scope:
    this.$scope.launch            = this.launch;
    this.$scope.submitAddPlayer   = this.addPlayer;
    this.$scope.removePlayer      = this.removePlayer;
    this.$scope.kickPlayer        = this.kickPlayer;
    this.$scope.setColor          = this.setColor;
    // Your colour circle in the room opens the colour picker; the colour is
    // sent (setColor) when the picker closes.
    this.$scope.$on('colorpicker-closed', this.onColorPicked.bind(this));
    this.$scope.setReady          = this.setReady;
    this.$scope.setName           = this.setName;
    this.$scope.setTouch          = this.setTouch;
    this.$scope.toggleParameters  = this.toggleParameters;
    this.$scope.copyCode          = this.copyCode.bind(this);
    this.$scope.othersReady       = this.othersReady.bind(this);
    this.$scope.enoughPlayers     = this.enoughPlayers.bind(this);
    this.$scope.minPlayers        = this.minPlayers;
    this.$scope.requestRematch    = this.requestRematch.bind(this);
    this.$scope.rematch           = null;
    this.$scope.pay               = null;   // entry fees being paid (server: room:pay)
    this.$scope.payLeft           = 0;
    this.$scope.entryFees         = false;  // entry fees on: READY = pay $2, no Start
    this.$scope.rematchMine       = false;
    this.onKicked                 = this.onKicked.bind(this);
    this.$scope.prizeLabel        = this.prizeLabel;
    this.$scope.nameMaxLength     = Player.prototype.maxLength;
    this.$scope.colorMaxLength    = Player.prototype.colorMaxLength;
    this.$scope.hasTouch          = this.hasTouch;
    this.$scope.autoTouch         = this.autoTouch;
    this.$scope.master            = this.repository.amIMaster();
    this.$scope.displayParameters = false;
    this.$scope.$parent.profile   = true;
    this.$scope.launching         = false;

    this.repository.start();
    gamepadListener.start();

    if (!this.profile.isComplete()) {
        this.profile.on('close', this.joinRoom);
        if (this.profile.controller.loaded) {
            this.profile.controller.openProfile();
        } else {
            this.profile.controller.on('loaded', this.profile.controller.openProfile);
        }
    } else {
        this.joinRoom();
    }
}

RoomController.prototype = Object.create(AbstractController.prototype);
RoomController.prototype.constructor = RoomController;

/**
 * Phone / tablet (touch is the main input), not a laptop that happens to
 * have a touchscreen.
 *
 * @return {Boolean}
 */
RoomController.isTouchDevice = function()
{
    var ua = navigator.userAgent || '';

    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) { return true; }
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) { return true; }

    return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
};

/**
 * Join room and load scope
 */
RoomController.prototype.joinRoom = function()
{
    if (!this.client.connected) {
        return this.client.on('connected', this.joinRoom);
    }

    this.profile.off('close', this.joinRoom);
    this.repository.join(this.name, this.password, this.onJoined);
};

/**
 * On room joined
 *
 * @param {Object} result
 */
RoomController.prototype.onJoined = function(result)
{
    if (result.success) {
        this.room        = result.room;
        this.$scope.room = this.room;

        this.attachEvents();
        this.adoptOwnPlayers();
        this.addProfileUser();
        this.requestDigestScope();
    } else {
        console.error('Could not join room %s: %s', result.name, result.error);
        if (/^Unknown room/.test(result.error || '')) {
            this.showToast('That match is no longer open.');
        }
        this.goHome();
        this.applyScope();
    }
};

/**
 * Leave room
 */
RoomController.prototype.leaveRoom = function()
{
    var path = this.$location.path();

    if (this.room) {
        if (path !== this.room.getGameUrl()) {
            this.repository.leave();
        }

        this.detachEvents();
    }
};

/**
 * Attach events
 */
RoomController.prototype.attachEvents = function()
{
    this.repository.on('room:close', this.goHome);
    this.repository.on('player:join', this.onJoin);
    this.repository.on('player:leave', this.requestDigestScope);
    this.repository.on('player:ready', this.requestDigestScope);
    this.repository.on('player:color', this.requestDigestScope);
    this.repository.on('player:name', this.requestDigestScope);
    this.repository.on('client:activity', this.requestDigestScope);
    this.repository.on('room:master', this.onRoomMaster);
    this.repository.on('room:game:start', this.start);
    this.repository.on('room:config:open', this.onConfigOpen);
    this.repository.on('room:launch:start', this.onLaunchStart);
    this.repository.on('room:launch:cancel', this.onLaunchCancel);
    this.repository.on('client:away', this.requestDigestScope);
    this.repository.on('player:client', this.onPlayerClient);
    this.repository.on('room:rematch', this.onRematch);
    this.repository.on('room:pay', this.onPay);
    this.repository.on('room:pay:cancelled', this.onPayCancelled);
    this.repository.on('room:fees', this.onFees);
    this.setRematch(this.repository.rematch);
    this.client.on('room:kicked', this.onKicked);
    this.client.on('room:superseded', this.onSuperseded);

    for (var i = this.room.players.items.length - 1; i >= 0; i--) {
        this.room.players.items[i].on('control:change', this.onControlChange);
    }
};

/**
 * Detach events
 */
RoomController.prototype.detachEvents = function()
{
    this.repository.off('room:close', this.goHome);
    this.repository.off('player:join', this.onJoin);
    this.repository.off('player:leave', this.requestDigestScope);
    this.repository.off('player:ready', this.requestDigestScope);
    this.repository.off('player:color', this.requestDigestScope);
    this.repository.off('player:name', this.requestDigestScope);
    this.repository.off('client:activity', this.requestDigestScope);
    this.repository.off('room:master', this.onRoomMaster);
    this.repository.off('room:game:start', this.start);
    this.repository.off('room:config:open', this.onConfigOpen);
    this.repository.off('room:launch:start', this.onLaunchStart);
    this.repository.off('room:launch:cancel', this.onLaunchCancel);
    this.repository.off('client:away', this.requestDigestScope);
    this.repository.off('player:client', this.onPlayerClient);
    this.repository.off('room:rematch', this.onRematch);
    this.repository.off('room:pay', this.onPay);
    this.repository.off('room:pay:cancelled', this.onPayCancelled);
    this.repository.off('room:fees', this.onFees);
    if (this.payInterval) { this.payInterval = clearInterval(this.payInterval); }
    this.client.off('room:kicked', this.onKicked);
    this.client.off('room:superseded', this.onSuperseded);

    if (this.room) {
        for (var i = this.room.players.items.length - 1; i >= 0; i--) {
            this.room.players.items[i].off('control:change', this.onControlChange);
        }
    }
};

/**
 * Go back to the homepage
 */
RoomController.prototype.goHome = function()
{
    this.$location.path('/');
};

/**
 * Launch game
 */
RoomController.prototype.launch = function()
{
    if (this.$scope.rematch) { return; }

    // "Start now!" needs 3+ players and every other player ready (the server
    // checks too); pressing it during the countdown cancels, as before.
    if (this.repository.amIMaster() && (this.$scope.launching || (this.enoughPlayers() && this.othersReady()))) {
        this.repository.launch();
    }
};

/**
 * Kurver needs at least this many players in the room to start (the server
 * enforces the same minimum).
 *
 * @type {Number}
 */
RoomController.prototype.minPlayers = 3;

/**
 * Enough players in the room to start?
 *
 * @return {Boolean}
 */
RoomController.prototype.enoughPlayers = function()
{
    return !!this.room && this.room.players.items.length >= this.minPlayers;
};

/**
 * Every player except the host's own is ready (the host starts instead of
 * readying).
 *
 * @return {Boolean}
 */
RoomController.prototype.othersReady = function()
{
    if (!this.room) { return false; }

    return this.room.players.items.every(function (player) {
        return (player.client && player.client.master) || (player.ready && !(player.client && player.client.away));
    });
};

/**
 * Press Rematch (accept the one that's pending)
 */
RoomController.prototype.requestRematch = function()
{
    this.repository.requestRematch();
};

/**
 * Show the rematch state: who pressed, who we're waiting for. Ready and
 * Start are held back while it's pending.
 *
 * @param {Object} rematch
 */
RoomController.prototype.setRematch = function(rematch)
{
    var mine = false;

    if (rematch && rematch.by && this.room) {
        mine = this.room.getLocalPlayers().items.some(function (player) { return rematch.by.indexOf(player.id) >= 0; });
    }

    this.$scope.rematch     = rematch && rematch.pending ? rematch : null;
    this.$scope.rematchMine = mine;
};

/**
 * Rematch state from the server
 *
 * @param {Event} e
 */
RoomController.prototype.onRematch = function(e)
{
    var rematch = e.detail;

    this.setRematch(rematch);

    if (rematch && rematch.accepted) {
        this.showToast('Rematch on — press Ready');
    } else if (rematch && rematch.cancelled) {
        this.showToast(rematch.cancelled);
    }

    this.requestDigestScope();
};

/**
 * Entry fees: this player's payment state from the server (amount and the
 * Stripe Checkout link come from it; the page only shows them).
 *
 * @param {Event} e
 */
RoomController.prototype.onPay = function(e)
{
    this.$scope.pay = e.detail;
    if (!this.payInterval) { this.payInterval = setInterval(this.tickPay, 1000); }
    this.tickPay();
    // The answer to our own READY: straight to our Stripe Checkout (same tab;
    // the room is rejoined when we come back).
    if (e.detail && e.detail.go && e.detail.url) { window.location.href = e.detail.url; }
};

/**
 * Entry fees on or off for this room (READY = pay $2, no Start).
 *
 * @param {Event} e
 */
RoomController.prototype.onFees = function(e)
{
    this.$scope.entryFees = !!(e.detail && e.detail.on);
    this.requestDigestScope();
};

/**
 * Seconds left to pay (shown in the payment box).
 */
RoomController.prototype.tickPay = function()
{
    var pay = this.$scope.pay;
    if (!pay) {
        if (this.payInterval) { this.payInterval = clearInterval(this.payInterval); }
        return;
    }
    this.$scope.payLeft = Math.max(0, Math.ceil((pay.deadline - Date.now()) / 1000));
    this.$scope.payClock = Math.floor(this.$scope.payLeft / 60) + ':' + ('0' + this.$scope.payLeft % 60).slice(-2);
    this.requestDigestScope();
};

/**
 * The payment window closed without a game (someone didn't pay / left).
 *
 * @param {Event} e
 */
RoomController.prototype.onPayCancelled = function(e)
{
    this.$scope.pay = null;
    this.tickPay();
    if (e.detail && e.detail.message) { this.showToast(e.detail.message); }
    this.requestDigestScope();
};

/**
 * The host removed us from the room: say so, and go back to the room list.
 *
 * @param {Event} e
 */
RoomController.prototype.onKicked = function(e)
{
    this.showToast((e && e.detail && e.detail.message) || 'You were removed by the host');
    this.goHome();
    this.applyScope();
};

/**
 * This seat was taken over by the same account somewhere else (another tab
 * or device): this page steps back to the room list and stays there.
 *
 * @param {Event} e
 */
RoomController.prototype.onSuperseded = function(e)
{
    try { window.sessionStorage.setItem('kurver_superseded', '1'); } catch (err) {}
    this.showToast((e && e.detail && e.detail.message) || 'You opened this match somewhere else.');
    this.room = null;
    this.goHome();
    this.applyScope();
};

/**
 * Short message at the top of the screen
 *
 * @param {String} message
 */
RoomController.prototype.showToast = function(message)
{
    var old = document.getElementById('kurver-kicked-toast'),
        toast = document.createElement('div');

    if (old) { old.parentNode.removeChild(old); }
    toast.id = 'kurver-kicked-toast';
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10000;background:#2a0f14;border:1px solid rgba(255,85,85,0.5);color:#ff8080;padding:12px 20px;border-radius:10px;font-family:Space Grotesk,sans-serif;font-size:14px;';
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) { toast.parentNode.removeChild(toast); } }, 6000);
};

/**
 * Add player
 */
RoomController.prototype.addPlayer = function(name, color)
{
    var $scope = this.$scope;

    name  = typeof(name) !== 'undefined' ? name : $scope.username;
    color = typeof(color) !== 'undefined' ? color : null;

    if (name) {
        this.repository.addPlayer(
            name,
            color,
            function (result) {
                if (result.success) {
                    $scope.username = null;
                    $scope.$apply();
                } else {
                    var error = typeof(result.error) !== 'undefined' ? result.error : 'Unknown error';
                    console.error('Could not add player %s: %s', name, error);
                }
            }
        );
    }
};

/**
 * Remove player
 */
RoomController.prototype.removePlayer = function(player)
{
    if (!player.local) { return; }

    this.repository.removePlayer(
        player,
        function (result) {
            if (!result.success) {
                console.error('Could not remove player %s', player.name);
            }
        }
    );
};

/**
 * Kick player
 */
RoomController.prototype.kickPlayer = function(player)
{
    var repository  = this;

    this.repository.kickPlayer(player, function (result) {
        if (!result.success) {
            console.error('Could not kick player %s', player.name);
        }
        repository.digestScope();
    });
};

/**
 * Go room config open
 */
RoomController.prototype.onConfigOpen = function(e)
{
    this.$location.search('password', this.room.config.password);
    this.applyScope();
};

/**
 * On join
 *
 * @param {Event} e
 */
RoomController.prototype.onJoin = function(e)
{
    var player = e.detail.player;

    if (player.client.id === this.client.id) {
        player.on('control:change', this.onControlChange);
        this.setupLocalPlayer(player);
    } else {
        this.notifier.notify('New player joined!');
    }

    this.requestDigestScope();
};

/**
 * Our own player: local controls, profile, touch
 *
 * @param {Player} player
 */
RoomController.prototype.setupLocalPlayer = function(player)
{
    player.setLocal(true);

    player.profile = this.profile.name === player.name;

    this.updateCurrentMessage();

    if (player.profile) {
        this.setProfileControls(player);
    }

    if (this.useTouch) {
        this.applyTouch(player);
    }
};

/**
 * Back in the room after a reconnect: the seat (player) that came with the
 * room is ours.
 */
RoomController.prototype.adoptOwnPlayers = function()
{
    for (var player, i = this.room.players.items.length - 1; i >= 0; i--) {
        player = this.room.players.items[i];
        if (!player.local && player.client && player.client.id === this.client.id) {
            this.setupLocalPlayer(player);
        }
    }
};

/**
 * A player moved to a new connection (they came back)
 *
 * @param {Event} e
 */
RoomController.prototype.onPlayerClient = function(e)
{
    var player = e.detail.player;

    if (!player.local && player.client && player.client.id === this.client.id) {
        this.setupLocalPlayer(player);
    }

    this.requestDigestScope();
};

/**
 * Touch controls for one player, without saving them over the keyboard
 * controls in the profile.
 *
 * @param {Player} player
 */
RoomController.prototype.applyTouch = function(player)
{
    var synchro = this.controlSynchro;

    this.controlSynchro = true;
    player.setTouch();
    this.controlSynchro = synchro;
};

/**
 * The colour picker on one of your own players closed: send its colour
 * (the server checks it and shows it to everyone in the room).
 *
 * @param {Event} e
 */
RoomController.prototype.onColorPicked = function(e)
{
    var player = e.targetScope ? e.targetScope.player : null;

    if (player && player.local) {
        this.setColor(player);
    }
};

/**
 * Set player color
 *
 * @return {Array}
 */
RoomController.prototype.setColor = function(player)
{
    if (!player.local) { return; }

    var controller = this;

    this.repository.setColor(
        player,
        player.color,
        function (result) {
            if (player.profile) {
                controller.profile.setColor(player.color);
            }
            controller.digestScope();
        }
    );
};

/**
 * Set player name
 *
 * @return {Array}
 */
RoomController.prototype.setName = function(player)
{
    if (!player.local) { return; }

    var controller = this;

    this.repository.setName(
        player.id,
        player.name,
        function (result) {
            if (!result.success) {
                var error = typeof(result.error) !== 'undefined' ? result.error : 'Unknown error',
                    name = typeof(result.name) !== 'undefined' ? result.name : null;

                console.error('Could not rename player: %s', error);

                if (name) {
                    player.name = name;
                }
            }

            if (player.profile) {
                controller.profile.setName(player.name);
            }

            controller.digestScope();
        }
    );
};

/**
 * Set player ready
 *
 * @return {Array}
 */
RoomController.prototype.setReady = function(player)
{
    if (this.$scope.rematch) { return; }

    if (!player.local) { return; }

    // One-way for players (the host starts instead): already ready → nothing to do.
    if (player.ready && !this.repository.amIMaster()) { return; }

    this.repository.setReady(
        player.id,
        function (result) {
            if (!result.success) {
                console.error('Could not set player %s ready', player.name);
            }
        }
    );
};

/**
 * Set touch for local players
 */
RoomController.prototype.setTouch = function()
{
    if (!this.hasTouch) { return; }

    this.useTouch = true;

    var players = this.room.getLocalPlayers();

    for (var i = players.items.length - 1; i >= 0; i--) {
        this.applyTouch(players.items[i]);
    }
};

/**
 * Start Game
 *
 * @param {Event} e
 */
RoomController.prototype.start = function(e)
{
    this.$location.path(this.room.getGameUrl());

    if (this.room.config.open) {
        this.$location.search('password', this.room.config.password);
    }

    this.applyScope();
};

/**
 * Add profile user
 */
RoomController.prototype.addProfileUser = function()
{
    if (!this.room.getLocalPlayers().isEmpty()) { return; }

    if (this.room.isNameAvailable(this.profile.name)) {
        this.profile.on('change', this.updateProfile);
        this.addPlayer(this.profile.name, this.profile.color);
    }
};

/**
 * Update profile
 */
RoomController.prototype.updateProfile = function()
{
    var player = this.room.players.match(function () { return this.profile; });

    if (player) {
        this.setProfileName(player);
        this.setProfileColor(player);
        this.setProfileControls(player);
    }
};

/**
 * Update current message
 */
RoomController.prototype.updateCurrentMessage = function()
{
    var profile = this.room.players.match(function () { return this.profile; }),
        player = this.room.players.match(function () { return this.local; });

    this.chat.setPlayer(profile ? profile : player);
};

/**
 * Triggered when a local player changes its controls
 *
 * @param {Event} e
 */
RoomController.prototype.onControlChange = function(e)
{
    this.saveProfileControls();
    this.digestScope();
};

/**
 * Save controls
 */
RoomController.prototype.saveProfileControls = function()
{
    var player = this.room.players.match(function () { return this.profile; });

    if (player && !this.controlSynchro) {
        this.controlSynchro = true;
        this.profile.setControls(player.getMapping());
        this.controlSynchro = false;
    }
};

/**
 * Set profile controls
 */
RoomController.prototype.setProfileControls = function(player)
{
    if (!this.controlSynchro) {
        this.controlSynchro = true;

        for (var i = this.profile.controls.length - 1; i >= 0; i--) {
            player.controls[i].loadMapping(this.profile.controls[i].getMapping());
        }

        this.controlSynchro = false;
        this.digestScope();
    }
};

/**
 * Set profile name
 */
RoomController.prototype.setProfileName = function(player)
{
    if (this.profile.name !== player.name) {
        player.setName(this.profile.name);
        this.setName(player);
    }
};

/**
 * Set profile color
 */
RoomController.prototype.setProfileColor = function(player)
{
    if (this.profile.color !== player.color) {
        player.setColor(this.profile.color);
        this.setColor(player);
    }
};

/**
 * Toggle parameters
 */
RoomController.prototype.onRoomMaster = function(e)
{
    this.$scope.master = this.repository.amIMaster();
    this.digestScope();
};

/**
 * On launch start
 *
 * @param {Event} e
 */
RoomController.prototype.onLaunchStart = function(e)
{
    this.clearLaunchInterval();
    this.launchInterval   = setInterval(this.onLaunchTimer, 1000);
    this.$scope.launching = this.repository.room.launchTime / 1000;
    this.digestScope();
};

/**
 * On launch cancel
 *
 * @param {Event} e
 */
RoomController.prototype.onLaunchCancel = function(e)
{
    this.clearLaunchInterval();
    this.$scope.launching = false;
    this.digestScope();
};

/**
 * On launch timer
 *
 * @param {Event} e
 */
RoomController.prototype.onLaunchTimer = function(e)
{
    if (this.$scope.launching) {
        this.$scope.launching--;
        this.digestScope();
    }
};

/**
 * Clear launch interval
 */
RoomController.prototype.clearLaunchInterval = function()
{
    if (this.launchInterval) {
        this.launchInterval = clearInterval(this.launchInterval);
    }
};

/**
 * Copy the match code (COPY CODE button)
 *
 * @param {Event} e
 */
RoomController.prototype.copyCode = function(e)
{
    var code = this.room && this.room.code,
        btn  = e && e.target;

    if (!code) { return; }

    var fallback = function () {
        var el = document.getElementById('kurver-match-code');
        if (!el) { return; }
        var range = document.createRange(), sel = window.getSelection();
        range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
        try { document.execCommand('copy'); } catch (err) {}
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).catch(fallback);
    } else {
        fallback();
    }

    if (btn) {
        btn.textContent = 'COPIED!';
        setTimeout(function () { btn.textContent = 'COPY CODE'; }, 2000);
    }
};

/**
 * Toggle parameters
 */
RoomController.prototype.toggleParameters = function()
{
    this.$scope.displayParameters = !this.$scope.displayParameters;
};

/**
 * Display-only live prize label for the current player count.
 * Same formula the server pays with (kurver-money.js prize()).
 *
 * @return {String}
 */
RoomController.prototype.prizeLabel = function()
{
    var count = this.room ? this.room.players.items.length : 0;

    // Same rule the server pays with (kurver-money.js prize()):
    // $2 × (n − 1) — 3 → $4, 4 → $6, 5 → $8; nothing to show while it's $0.
    var prize = Math.max(0, 2 * (count - 1));

    if (!prize) {
        return 'Waiting for players… (min 3)';
    }

    return count + ' players — Prize: $' + prize;
};
