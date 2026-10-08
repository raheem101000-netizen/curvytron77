/**
 * Rooms Controller
 *
 * @param {Object} $scope
 * @param {Object} $location
 * @param {SocketClient} client
 */
function RoomsController($scope, $location, client)
{
    AbstractController.call(this, $scope);

    document.body.classList.remove('game-mode');

    this.$location  = $location;
    this.client     = client;
    this.repository = new RoomsRepository(this.client);
    this.pendingPassword = null;

    // Binding:
    this.createRoom   = this.createRoom.bind(this);
    this.onCreateRoom = this.onCreateRoom.bind(this);
    this.joinRoom     = this.joinRoom.bind(this);
    this.joinByCode   = this.joinByCode.bind(this);
    this.quickPlay    = this.quickPlay.bind(this);
    this.openCreate   = this.openCreate.bind(this);
    this.openJoin     = this.openJoin.bind(this);
    this.closeModals  = this.closeModals.bind(this);
    this.detachEvents = this.detachEvents.bind(this);

    this.$scope.$on('$destroy', this.detachEvents);
    if (!this.$scope.inRoom) {
        this.$location.search('password', null);
    }

    // Hydrating the scope:
    this.$scope.rooms             = this.repository.rooms;
    this.$scope.createRoom        = this.createRoom;
    this.$scope.join              = this.joinRoom;
    this.$scope.joinByCode        = this.joinByCode;
    this.$scope.quickPlay         = this.quickPlay;
    this.$scope.openCreate        = this.openCreate;
    this.$scope.openJoin          = this.openJoin;
    this.$scope.closeModals       = this.closeModals;
    this.$scope.backdropClose     = function (e) { if (e && e.target === e.currentTarget) { this.closeModals(); } }.bind(this);
    this.$scope.roomMaxLength     = Room.prototype.maxLength;
    this.$scope.passwordMaxLength = 20;
    // Create popup (same fields as FIFA/Puz): name, public/private, password.
    this.$scope.createForm        = {visible: false, name: '', type: 'public', password: '', error: '', busy: false};
    // Join with code popup: code + password (private matches only).
    this.$scope.joinForm          = {visible: false, code: '', password: '', error: '', busy: false, locked: false};
    this.$scope.$parent.profile   = true;

    this.attachEvents();
    this.findSeat();
}

RoomsController.prototype = Object.create(AbstractController.prototype);
RoomsController.prototype.constructor = RoomsController;

/**
 * Attach Events
 */
RoomsController.prototype.findSeat = function()
{
    // Still holding a seat in a match (dropped, closed the page, came back
    // from tenten.run)? Go straight back to it. Not after this tab handed its
    // seat to another tab/device.
    var superseded = false;
    try { superseded = window.sessionStorage.getItem('kurver_superseded') === '1'; } catch (e) {}
    if (superseded || !this.client.connected) { return; }

    var controller = this;

    this.client.addEvent('seat:find', null, function (result) {
        if (result && result.success && result.name && controller.$location.path() === '/') {
            controller.$location.path('/room/' + encodeURIComponent(result.name));
            controller.applyScope();
        }
    });
};

RoomsController.prototype.attachEvents = function()
{
    this.repository.on('room:open', this.requestDigestScope);
    this.repository.on('room:close', this.requestDigestScope);
    this.repository.on('room:players', this.requestDigestScope);
    this.repository.on('room:game', this.requestDigestScope);
    this.repository.on('room:config:open', this.requestDigestScope);

    this.repository.start();
};

/**
 * Attach Events
 */
RoomsController.prototype.detachEvents = function()
{
    this.repository.stop();

    this.repository.off('room:open', this.requestDigestScope);
    this.repository.off('room:close', this.requestDigestScope);
    this.repository.off('room:players', this.requestDigestScope);
    this.repository.off('room:game', this.requestDigestScope);
    this.repository.off('room:config:open', this.requestDigestScope);
};

/**
 * Open the create-match popup
 */
RoomsController.prototype.openCreate = function()
{
    var form = this.$scope.createForm;

    form.name = ''; form.type = 'public'; form.password = ''; form.error = ''; form.busy = false;
    form.visible = true;
    this.$scope.joinForm.visible = false;
    setTimeout(function () { var el = document.getElementById('kurver-create-name'); if (el) { el.focus(); } }, 50);
};

/**
 * Open the join-with-code popup (code prefilled when opened from a private
 * match in the list)
 *
 * @param {String} code
 */
RoomsController.prototype.openJoin = function(code)
{
    var form = this.$scope.joinForm;

    form.code = typeof(code) === 'string' ? code : ''; form.password = ''; form.error = ''; form.busy = false;
    form.locked = !!form.code;
    form.visible = true;
    this.$scope.createForm.visible = false;
    setTimeout(function () { var el = document.getElementById(form.locked ? 'kurver-join-password' : 'kurver-join-code'); if (el) { el.focus(); } }, 50);
};

/**
 * Close popups
 */
RoomsController.prototype.closeModals = function()
{
    this.$scope.createForm.visible = false;
    this.$scope.joinForm.visible   = false;
};

/**
 * Create a match (from the popup)
 */
RoomsController.prototype.createRoom = function()
{
    var form = this.$scope.createForm,
        name = (form.name || '').trim(),
        priv = form.type === 'private';

    form.error = '';

    if (form.busy) { return; }
    if (!name) { form.error = 'Enter a match name.'; return; }
    if (priv && !(form.password || '').trim()) { form.error = 'Enter a password for a private match.'; return; }

    form.busy = true;
    this.pendingPassword = priv ? form.password : null;
    this.repository.create(name, this.onCreateRoom, {open: !priv, password: this.pendingPassword});
};

/**
 * On create Room
 *
 * @param {Object} result
 */
RoomsController.prototype.onCreateRoom = function(result)
{
    var form = this.$scope.createForm;

    form.busy = false;

    if (result.success) {
        var room = this.repository.createRoom(result.room);
        this.closeModals();
        this.goToRoom(room.name, room.open ? null : this.pendingPassword);
    } else {
        form.error = result.error || 'Could not create the match.';
    }

    this.pendingPassword = null;
    this.applyScope();
};

/**
 * Join with code (from the popup)
 */
RoomsController.prototype.joinByCode = function()
{
    var controller = this,
        form       = this.$scope.joinForm,
        code       = (form.code || '').trim(),
        password   = form.password || '';

    form.error = '';

    if (form.busy) { return; }
    if (!code) { form.error = 'Enter a match code.'; return; }

    form.busy = true;
    this.repository.findByCode(code, password, function (result) {
        form.busy = false;

        if (result.success) {
            controller.closeModals();
            controller.goToRoom(result.name, result.open ? null : password);
        } else {
            form.error = result.error || 'Could not join that match.';
        }

        controller.applyScope();
    });
};

/**
 * Go to a room page (which joins it, with the password for private matches)
 *
 * @param {String} name
 * @param {String} password
 */
RoomsController.prototype.goToRoom = function(name, password)
{
    var path = this.$location.path('/room/' + encodeURIComponent(name));

    if (password) {
        path.search('password', password);
    }
};

/**
 * Join a room from the list: public → straight in; private → the
 * join-with-code popup with its code filled in, asking for the password.
 */
RoomsController.prototype.joinRoom = function(room)
{
    if (room.open) {
        this.$location.path(room.getUrl());
    } else {
        this.openJoin(room.code || '');
    }
};

/**
 * Quick play
 */
RoomsController.prototype.quickPlay = function()
{
    var room = this.repository.rooms.filter(function () { return !this.game && this.open; }).getRandomItem();

    if (room) {
        this.joinRoom(room);
    } else {
        this.openCreate();
    }
};
