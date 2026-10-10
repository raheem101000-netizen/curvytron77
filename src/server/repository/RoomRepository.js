/**
 * Room Repository
 */
function RoomRepository()
{
    EventEmitter.call(this);

    this.generator = new RoomNameGenerator();
    this.rooms     = new Collection([], 'name');
    this.codes     = {};

    this.onRoomClose = this.onRoomClose.bind(this);

}

RoomRepository.prototype = Object.create(EventEmitter.prototype);
RoomRepository.prototype.constructor = RoomRepository;

/**
 * Create a room
 *
 * @param {String} name
 *
 * @return {Room}
 */
RoomRepository.prototype.create = function(name, options)
{
    // Kurver: the host always names the match — no auto-generated names.
    if (typeof(name) !== 'string' || !name) { return false; }

    var room = new Room(name);

    // Shareable match code (same format as FIFA/Puz's Match ID: 9 characters).
    room.code = this.getUniqueCode();

    // 1v1 prize setting ("5" | "10" | "both"); the prize of the last game
    // launched here (a rematch in a "both" room starts both players on it).
    room.prizeMode = options && options.prizeMode ? options.prizeMode : null;
    room.lastPrize = null;

    // Private: the host's own password, set before the room is listed.
    if (options && typeof(options.password) === 'string' && options.password.length) {
        room.config.setPrivate(options.password);
    }

    if (!this.rooms.add(room)) { return false; }

    this.codes[room.code] = room;
    room.on('close', this.onRoomClose);
    this.emit('room:open', {room: room});

    return room;
};

/**
 * Delete a room
 *
 * @param {Room} room
 */
RoomRepository.prototype.remove = function(room)
{
    if (this.rooms.remove(room)) {
        if (room.code && this.codes[room.code] === room) { delete this.codes[room.code]; }
        this.emit('room:close', {room: room});

        return true;
    }

    return false;
};

/**
 * Get by name
 *
 * @param {String} name
 *
 * @return {Room}
 */
RoomRepository.prototype.get = function(name)
{
    return this.rooms.getById(name);
};

/**
 * Get by match code
 *
 * @param {String} code
 *
 * @return {Room}
 */
RoomRepository.prototype.getByCode = function(code)
{
    return Object.prototype.hasOwnProperty.call(this.codes, code) ? this.codes[code] : null;
};

/**
 * A match code no open match is using: 9 characters, same alphabet as
 * FIFA/Puz's Colyseus room IDs (A-Z a-z 0-9 _ -).
 *
 * @return {String}
 */
RoomRepository.prototype.getUniqueCode = function()
{
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
        code;

    do {
        var bytes = require('crypto').randomBytes(9);
        code = '';
        for (var i = 0; i < 9; i++) { code += alphabet[bytes[i] & 63]; }
    } while (this.codes[code]);

    return code;
};

/**
 * Get all
 *
 * @return {Array}
 */
RoomRepository.prototype.all = function()
{
    return this.rooms.items;
};

/**
 * On room close
 *
 * @param {Object} data
 */
RoomRepository.prototype.onRoomClose = function(data)
{
    this.remove(data.room);
};

/**
 * Get random room name
 *
 * @return {String}
 */
RoomRepository.prototype.getRandomRoomName = function()
{
    var name = this.generator.getName();

    while (this.rooms.ids.indexOf(name) >= 0) {
        name = this.generator.getName();
    }

    return name;
};
