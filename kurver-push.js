'use strict';
/**
 * Browser push notifications: "a game is filling up" to everyone who turned
 * match alerts on at tenten.run (push_subscriptions in the SHARED mediaskills
 * database, filled by tenten.run's /api/push-subscribe). Same behaviour as
 * 1v1 Arena's and Pong's server/src/pushNotifications.ts, for Kurver's
 * plain-Node server. Used by the game bundle (bin/curvytron.js, via
 * src/server/dependencies.js) when a public match is created.
 *
 * Never blocks or breaks the game: everything is fire-and-forget and every
 * failure is logged. A subscription the push service reports as gone
 * (404/410) is deleted. At most one push per game per COOLDOWN_MS, so a burst
 * of matches doesn't buzz everyone repeatedly (skipped, not queued). The
 * cooldown is per game and per server, so Arena, Pong and Kurver never hold
 * each other back.
 *
 * Needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto:…) in
 * the environment — the same key pair tenten.run hands to browsers — and
 * DATABASE_URL. Without them, pushes are skipped (logged once).
 */
const webpush = require('web-push');
const { pool } = require('./kurver-money.js');

const COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_MS) || 60000;   // env override: local tests only
const MIGRATION_LOCK = 727274;                                         // the shared-table migration lock

async function migratePushSubscriptions() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id          SERIAL PRIMARY KEY,
                endpoint    TEXT NOT NULL UNIQUE,
                p256dh      TEXT NOT NULL,
                auth        TEXT NOT NULL,
                user_id     INTEGER,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);
        await client.query('COMMIT');
        console.log('[push] push_subscriptions table ready');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[push] migration failed — match alerts won\'t be sent until this is fixed:', e);
    } finally {
        client.release();
    }
}

let vapidReady = null;
function ensureVapid() {
    if (vapidReady !== null) return vapidReady;
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — match alerts are off');
        return (vapidReady = false);
    }
    try {
        webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:raheem101000@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
        return (vapidReady = true);
    } catch (e) {
        console.error('[push] bad VAPID keys — match alerts are off:', e);
        return (vapidReady = false);
    }
}

const lastSentAt = new Map();   // game → last fan-out (ms)

/**
 * Alert every subscriber that a match opened: {title, body, url, tag?}.
 * Returns a promise you don't need to wait for; it never rejects.
 */
function notifyNewRoom(game, alert) {
    return sendAll(game, alert).catch(e => console.error(`[push] ${game} alert failed (the match is unaffected):`, e));
}

async function sendAll(game, alert) {
    if (!ensureVapid()) return;
    const now = Date.now();
    const last = lastSentAt.get(game) || 0;
    if (now - last < COOLDOWN_MS) {
        console.log(`[push] ${game}: skipped (another alert went out ${Math.round((now - last) / 1000)} s ago)`);
        return;
    }
    lastSentAt.set(game, now);

    const subs = (await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions')).rows;
    if (!subs.length) return;
    const payload = JSON.stringify({ title: alert.title, body: alert.body, url: alert.url, tag: alert.tag || game });
    let sent = 0, gone = 0, failed = 0;
    // In parallel; each subscription is dealt with as soon as its own send ends
    // (a slow push service never delays removing an expired one), 10 s timeout.
    await Promise.all(subs.map(async s => {
        try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60, timeout: 10000 });
            sent++;
        } catch (e) {
            const code = e && e.statusCode;
            if (code === 404 || code === 410) {
                gone++;
                await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
            } else {
                failed++;
                console.error(`[push] ${game}: send failed (${code || (e && e.code) || 'network'}) for subscription ${s.id}`);
            }
        }
    }));
    console.log(`[push] ${game}: ${sent} sent, ${gone} expired removed, ${failed} failed`);
}

if (process.env.DATABASE_URL) { migratePushSubscriptions(); }

module.exports = { notifyNewRoom, migratePushSubscriptions };
