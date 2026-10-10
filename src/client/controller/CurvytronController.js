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
    this.onNotice      = this.onNotice.bind(this);

    // Hydrate scope
    this.$scope.status  = 'connecting';
    this.$scope.reload  = this.reload;
    this.$scope.profile = false;

    this.client.on('connected', this.onConnect);
    this.client.on('disconnected', this.onDisconnect);
    this.client.on('kurver:notice', this.onNotice);
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
 * A message from the server for this player, on whatever screen they're on
 * ("You're already playing in another tab", "You left the game: … won").
 * Stays 15 s; click to close.
 *
 * @param {Event} e
 */
CurvytronController.prototype.onNotice = function(e)
{
    var message = e && e.detail && e.detail.message,
        old = document.getElementById('kurver-notice'),
        note;

    if (!message) { return; }
    if (old) { old.parentNode.removeChild(old); }

    note = document.createElement('div');
    note.id = 'kurver-notice';
    note.textContent = message;
    note.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10001;max-width:calc(100% - 32px);background:#14102a;border:1px solid rgba(180,80,255,0.6);color:#fff;padding:12px 20px;border-radius:10px;font-family:Space Grotesk,sans-serif;font-size:14px;cursor:pointer;text-align:center;';
    note.onclick = function () { if (note.parentNode) { note.parentNode.removeChild(note); } };
    document.body.appendChild(note);
    setTimeout(note.onclick, 15000);
};

/**
 * Reload
 */
CurvytronController.prototype.reload = function()
{
    this.scheduleReconnect(true);
};
