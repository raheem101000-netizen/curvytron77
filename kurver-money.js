'use strict';
/**
 * Kurver ↔ tenten.run: login, prize and win credit.
 *
 * Same behaviour as FIFA/Puz Royale (fifa-match server/src/auth.ts,
 * puz-royale-clause- server/src/prize.ts + payouts.ts), re-implemented for
 * Kurver's plain-Node curvytron server. Used by the game bundle
 * (bin/curvytron.js, via src/server/dependencies.js).
 *
 * Talks to the SHARED mediaskills Neon database (DATABASE_URL): users,
 * game_tokens, game_wins, balance_ledger, match_results. This is not the
 * legacy KURVER_DATABASE_URL `balances` table in db.js.
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 8,
});

// ── Login ────────────────────────────────────────────────────────────────────
// tenten.run's /api/token?action=generate inserts a game_tokens row for the
// logged-in account; the homepage's Kurver PLAY button carries {token,
// player_id} here. Checked as `token AND user_id` and NOT consumed (the same
// token is reused for every reconnect), bounded to tokens issued in the last
// 12 h via created_at (both sides are `timestamp without time zone`, hence
// LOCALTIMESTAMP).
const TOKEN_MAX_AGE_HOURS = 12;

class AuthError extends Error {}

async function authenticate(token, playerId) {
    const userId = Number(playerId);
    if (typeof token !== 'string' || !token || !Number.isInteger(userId) || userId <= 0) {
        throw new AuthError('Log in on tenten.run to play');
    }
    const result = await pool.query(
        `SELECT u.id, u.display_name
           FROM game_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token = $1 AND t.user_id = $2
            AND t.created_at > LOCALTIMESTAMP - make_interval(hours => $3)`,
        [token, userId, TOKEN_MAX_AGE_HOURS]
    );
    if (!result.rows.length) {
        throw new AuthError('Your login has expired — go back to tenten.run and press PLAY on Kurver again');
    }
    return { userId: result.rows[0].id, displayName: result.rows[0].display_name };
}

// The WebSocket upgrade URL carries the handoff: /multiplayer?token=…&player_id=…
function authenticateUpgrade(requestUrl) {
    let params;
    try { params = new URL(requestUrl, 'http://x').searchParams; } catch (e) { params = new URLSearchParams(); }
    return authenticate(params.get('token'), params.get('player_id'));
}

// ── Prize ────────────────────────────────────────────────────────────────────
// Same rule as Puz Royale's prize.ts today: no minimum player count.
//   n = 3 → $5;  otherwise $2 × (n − 1), floored at $0
//   e.g. 1→$0, 2→$2, 4→$6, 5→$8, 6→$10
// n = the real accounts in the game when it started (frozen then).
function prize(startedPlayers) {
    const n = Math.floor(Number(startedPlayers) || 0);
    if (n === 3) return 5;
    return Math.max(0, 2 * (n - 1));
}

// ── Mode and 1v1 prizes ──────────────────────────────────────────────────────
// KURVER_MODE: "1v1" (default) — a room seats exactly 2 players who agree on
// one of the prizes below (same rules as FIFA / Pong); "multiplayer" — the
// original rooms: $2 entry, prize by player count (prize() above). Read on
// every call, like the payout kill-switch.
function mode() {
    return process.env.KURVER_MODE === 'multiplayer' ? 'multiplayer' : '1v1';
}
function isOneVOne() { return mode() === '1v1'; }

// The ONE place the 1v1 prizes are defined (dollars, exact strings): the
// server validates and credits from it, and the lobby pages load it from
// /kurver-config.js — a label, a credit and a charge can never disagree.
const PRIZES = {
    5: { prize: '5.00', entryFee: '2.99' },
    10: { prize: '10.00', entryFee: '5.99' },
};
function asPrize(v) { const n = Number(v); return n === 5 || n === 10 ? n : null; }
function asPrizeMode(v) { return v === '5' || v === '10' || v === 'both' ? v : null; }
// What the winner of a match on this prize is credited.
function prizeAmount(p) { return PRIZES[p].prize; }
// Entry fee each player pays for the agreed prize — the hook for when entry
// charging is built (nothing is charged yet).
function entryFeeFor(p) { return PRIZES[p].entryFee; }
// Served as /kurver-config.js for the pages.
function clientScript() {
    return 'window.KURVER = ' + JSON.stringify({ mode: mode(), prizes: PRIZES }) + ';\n';
}

// ── Kill-switch ──────────────────────────────────────────────────────────────
// Payouts are ON by default. KURVER_PAYOUTS_ENABLED=false (exactly "false")
// turns them OFF: games play and end normally, creditWin credits nothing and
// touches no tables. Read on every call — switching is just setting the
// variable in Render.
function payoutsEnabled() {
    return process.env.KURVER_PAYOUTS_ENABLED !== 'false';
}

// ── Win credit ───────────────────────────────────────────────────────────────
// ONE transaction. Dedupe key game_wins.stripe_payment_id = 'kurver:<gameKey>'
// (plain UNIQUE index): a retry or two end-of-game paths racing all hit the
// same key, so a game credits its winner exactly once. Rolls back on any error.
const KURVER_GAME = 'kurver';
const KURVER_MATCH_NUMBER = 0; // NOT NULL in the shared tables; Kurver has no Pong-style cycle position

function newGameKey() {
    return crypto.randomBytes(12).toString('hex');
}

async function creditWin(opts) {
    if (!payoutsEnabled()) return { status: 'disabled' };
    const amount = Number(opts.amount).toFixed(2);
    const key = KURVER_GAME + ':' + opts.gameKey;
    const tier = opts.startedPlayers + 'P';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const claim = await client.query(
            `INSERT INTO game_wins (player_id, game, match_number, stripe_payment_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT (stripe_payment_id) DO NOTHING RETURNING id`,
            [opts.winnerUserId, KURVER_GAME, KURVER_MATCH_NUMBER, key]
        );
        if (!claim.rowCount) { await client.query('ROLLBACK'); return { status: 'already_credited' }; }

        const before = await client.query(`SELECT COALESCE(balance, 0) AS balance FROM users WHERE id = $1 FOR UPDATE`, [opts.winnerUserId]);
        if (!before.rowCount) throw new Error('winner user ' + opts.winnerUserId + ' not found');
        const after = await client.query(
            `UPDATE users SET balance = COALESCE(balance, 0) + $2::numeric WHERE id = $1 RETURNING balance`,
            [opts.winnerUserId, amount]
        );
        await client.query(
            `INSERT INTO balance_ledger (player_id, game, match_number, reason, delta, balance_before, balance_after, stripe_payment_id)
             VALUES ($1, $2, $3, 'win_credit', $4::numeric, $5, $6, $7)`,
            [opts.winnerUserId, KURVER_GAME, KURVER_MATCH_NUMBER, amount, before.rows[0].balance, after.rows[0].balance, key]
        );
        await client.query(
            `INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
             VALUES ($1, $2, $3, 'win', $4, $5, true) ON CONFLICT (stripe_payment_id) DO NOTHING`,
            [opts.winnerUserId, KURVER_GAME, key, tier, KURVER_MATCH_NUMBER]
        );
        for (const loserId of opts.loserUserIds || []) {
            await client.query(
                `INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
                 VALUES ($1, $2, $3, 'loss', $4, $5, false) ON CONFLICT (stripe_payment_id) DO NOTHING`,
                [loserId, KURVER_GAME, key + ':loss:' + loserId, tier, KURVER_MATCH_NUMBER]
            );
        }
        await client.query('COMMIT');
        return { status: 'credited', amount, balanceBefore: Number(before.rows[0].balance).toFixed(2), balanceAfter: Number(after.rows[0].balance).toFixed(2) };
    } catch (e) {
        await client.query('ROLLBACK').catch(function () {});
        throw e;
    } finally {
        client.release();
    }
}

// Retries (safe: the per-game key means a re-run can never double-credit).
// Resolves to what the winner's client is told.
async function creditWinWithRetry(opts) {
    const delays = [0, 1000, 3000];
    for (let i = 0; i < delays.length; i++) {
        if (delays[i]) await new Promise(function (r) { setTimeout(r, delays[i]); });
        try {
            const out = await creditWin(opts);
            console.log('[kurver-credit] game ' + opts.gameKey + ' → user ' + opts.winnerUserId + ': ' + out.status +
                (out.status === 'credited' ? ' $' + out.amount + ' (' + out.balanceBefore + ' → ' + out.balanceAfter + ')' : '') +
                (out.status === 'disabled' ? ' — would have been $' + Number(opts.amount).toFixed(2) + '; payouts are OFF (KURVER_PAYOUTS_ENABLED=false)' : ''));
            if (out.status === 'disabled') return { status: 'disabled' };
            return { status: 'credited', amount: Number(opts.amount).toFixed(2) };
        } catch (e) {
            console.error('[kurver-credit] attempt ' + (i + 1) + ' failed for game ' + opts.gameKey + ':', e);
        }
    }
    console.error('[kurver-credit] GAVE UP — game ' + opts.gameKey + ', winner user ' + opts.winnerUserId + ' is owed $' + Number(opts.amount).toFixed(2));
    return { status: 'failed' };
}

module.exports = { authenticate, authenticateUpgrade, AuthError, prize, payoutsEnabled, newGameKey, creditWin, creditWinWithRetry, pool,
    mode, isOneVOne, PRIZES, asPrize, asPrizeMode, prizeAmount, entryFeeFor, clientScript };
