/**
 * RoomsRepository
 *
 * @param {SocketCLient} client
 */
function RoomsRepository(client)
{
    EventEmitter.call(this);

    this.client = client;
    this.rooms  = new Collection([], 'name');

    this.start            = this.start.bind(this);
    this.onRoomOpen       = this.onRoomOpen.bind(this);
    this.onRoomClose      = this.onRoomClose.bind(this);
    this.onRoomPlayers    = this.onRoomPlayers.bind(this);
    this.onRoomGame       = this.onRoomGame.bind(this);
    this.onRoomConfigOpen = this.onRoomConfigOpen.bind(this);
    this.onRoomPrize      = this.onRoomPrize.bind(this);
}

RoomsRepository.prototype = Object.create(EventEmitter.prototype);
RoomsRepository.prototype.constructor = RoomsRepository;

/**
 * Attach events
 */
RoomsRepository.prototype.attachEvents = function()
{
    this.client.on('room:open', this.onRoomOpen);
    this.client.on('room:close', this.onRoomClose);
    this.client.on('room:players', this.onRoomPlayers);
    this.client.on('room:game', this.onRoomGame);
    this.client.on('room:config:open', this.onRoomConfigOpen);
    this.client.on('room:prize', this.onRoomPrize);
};

/**
 * Attach events
 */
RoomsRepository.prototype.detachEvents = function()
{
    this.client.off('room:open', this.onRoomOpen);
    this.client.off('room:close', this.onRoomClose);
    this.client.off('room:players', this.onRoomPlayers);
    this.client.off('room:game', this.onRoomGame);
    this.client.off('room:config:open', this.onRoomConfigOpen);
    this.client.off('room:prize', this.onRoomPrize);
};

/**
 * Get all
 *
 * @return {Array}
 */
RoomsRepository.prototype.all = function()
{
    return this.rooms;
};

/**
 * Get all
 *
 * @return {Array}
 */
RoomsRepository.prototype.get = function(name)
{
    return this.rooms.getById(name);
};

/**
 * Create
 *
 * @param {String} name
 * @param {Function} callback
 */
RoomsRepository.prototype.create = function(name, callback, options)
{
    if (typeof(name) === 'string') {
        name = name.substr(0, Room.prototype.maxLength).trim();
    }

    var data = {name: name};

    if (options && options.open === false) {
        data.open     = false;
        data.password = options.password;
    }

    if (options && options.prizeMode) {
        data.prizeMode = options.prizeMode;
    }

    this.client.addEvent('room:create', data, callback);
};

/**
 * Find the match a code belongs to (checks password / started on the server)
 *
 * @param {String} code
 * @param {String} password
 * @param {Function} callback
 */
RoomsRepository.prototype.findByCode = function(code, password, callback)
{
    this.client.addEvent('room:code', {code: code, password: password}, callback);
};

/**
 * Create room proxy object from data
 *
 * @param {Object} data
 *
 * @return {Object}
 */
RoomsRepository.prototype.createRoom = function(data)
{
    var room = new RoomListItem(data.name, data.players,  data.game, data.open, data.code);

    room.prizeMode = data.prizeMode || null;

    return room;
};

/**
 * A room's prize changed (1v1: the host of a fixed-prize room changed it)
 *
 * @param {Event} e
 */
RoomsRepository.prototype.onRoomPrize = function(e)
{
    var room = this.get(e.detail.name);

    if (room) {
        room.prizeMode = e.detail.prizeMode;
        this.emit('room:players', room);
    }
};

// EVENTS:

/**
 * On room open
 *
 * @param {Event} e
 *
 * @return {Boolean}
 */
RoomsRepository.prototype.onRoomOpen = function(e)
{
    var room = this.createRoom(e.detail);

    if(this.rooms.add(room)) {
        this.emit('room:open', {room: room});
    }
};

/**
 * On close room
 *
 * @param {Event} e
 *
 * @return {Boolean}
 */
RoomsRepository.prototype.onRoomClose = function(e)
{
    var room = this.get(e.detail.name);

    if(room && this.rooms.remove(room)) {
        this.emit('room:close', room);
    }
};

/**
 * On room config open change
 *
 * @param {Event} e
 *
 * @return {Boolean}
 */
RoomsRepository.prototype.onRoomConfigOpen = function(e)
{
    var room = this.get(e.detail.name);

    if(room) {
        room.open = e.detail.open;
        this.emit('room:config:open', room);
    }
};

/**
 * On room players change
 *
 * @param {Event} e
 *
 * @return {Boolean}
 */
RoomsRepository.prototype.onRoomPlayers = function(e)
{
    var room = this.get(e.detail.name);

    if(room) {
        room.players = e.detail.players;
        this.emit('room:players', room);
    }
};

/**
 * On room game change
 *
 * @param {Event} e
 *
 * @return {Boolean}
 */
RoomsRepository.prototype.onRoomGame = function(e)
{
    var room = this.get(e.detail.name);

    if(room) {
        room.game = e.detail.game;
        this.emit('room:game', room);
    }
};

/**
 * Start
 */
RoomsRepository.prototype.start = function()
{
    if (this.client.connected) {
        this.attachEvents();
        this.client.addEvent('room:fetch');
    } else {
        this.client.on('connected', this.start);
    }
};

/**
 * Pause
 */
RoomsRepository.prototype.stop = function()
{
    this.detachEvents();
    this.rooms.clear();
};
