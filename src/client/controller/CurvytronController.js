/**
 * Curvytron Controller
 *
 * @param {Object} $scope
 * @param {Object} $window
 * @param {Object} $location
 * @param {Profile} profile
 * @param {Analyser} analyser
 * @param {ActivityWatcher} watcher
 */
function CurvytronController($scope, $window, $location, profile, analyser, watcher, client)
{
    AbstractController.call(this, $scope);

    this.$window       = $window;
    this.$location     = $location;
    this.analyser      = analyser;
    this.watcher       = watcher;
    this.client        = client;

    // Bind
    this.onConnect     = this.onConnect.bind(this);
    this.onDisconnect  = this.onDisconnect.bind(this);
    this.reload        = this.reload.bind(this);

    // Hydrate scope
    this.$scope.status  = 'connecting';
    this.$scope.reload  = this.reload;
    this.$scope.profile = false;

    this.client.on('connected', this.onConnect);
    this.client.on('disconnected', this.onDisconnect);
}

CurvytronController.prototype = Object.create(AbstractController.prototype);
CurvytronController.prototype.constructor = CurvytronController;

/**
 * On connect
 *
 * @param {Event} e
 */
CurvytronController.prototype.onConnect = function(e)
{
    try { window.sessionStorage.removeItem('kurver_reconnects'); } catch (err) {}
    this.$scope.status  = 'online';
    this.$scope.profile = true;
    this.digestScope();
};

/**
 * On disconnect
 *
 * @param {Event} e
 */
CurvytronController.prototype.onDisconnect = function(e)
{
    document.body.classList.remove('game-mode');
    this.$scope.status = 'disconnected';
    this.digestScope();
    this.scheduleReconnect(false);
};

/**
 * Reconnect by reloading the same page (same match URL): the new connection
 * takes the player's seat back. Backs off 1 s, 2 s, 4 s … up to 15 s; an
 * expired login goes through tenten.run for a fresh one (index.html).
 *
 * @param {Boolean} now
 */
CurvytronController.prototype.scheduleReconnect = function(now)
{
    if (this.reconnectTimer) {
        if (!now) { return; }
        clearTimeout(this.reconnectTimer);
    }

    var attempts = 0;
    try { attempts = Number(window.sessionStorage.getItem('kurver_reconnects')) || 0; } catch (err) {}

    this.reconnectTimer = setTimeout(function () {
        try { window.sessionStorage.setItem('kurver_reconnects', attempts + 1); } catch (err) {}
        window.onbeforeunload = null;
        if (window.KurverLogin && window.KurverLogin.reconnect) {
            window.KurverLogin.reconnect();
        } else {
            window.location.reload();
        }
    }, now ? 0 : Math.min(15000, 1000 * Math.pow(2, attempts)));
};

/**
 * Reload
 */
CurvytronController.prototype.reload = function()
{
    this.scheduleReconnect(true);
};
