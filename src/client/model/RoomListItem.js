/**
 * Room list item
 *
 * @param {String} name
 * @param {Number} players
 * @param {Boolean} game
 * @param {Boolean} open
 */
function RoomListItem(name, players, game, open, code)
{
    this.name     = name;
    this.players  = players;
    this.game     = game;
    this.open     = open;
    this.code     = code || null;
    this.password = '';
}

/**
 * Get url
 *
 * @return {String}
 */
RoomListItem.prototype.getUrl = function()
{
    return '/room/' + encodeURIComponent(this.name);
};
