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
// The pot: $2 × (n − 1) — every player's $2 entry except one (TENTEN's),
// floored at $0. A game needs 3+ players to start (RoomController), so
//   3→$4, 4→$6, 5→$8, 6→$10, 8→$14, 10→$18.
// n = the real accounts in the game when it started (frozen then).
function prize(startedPlayers) {
    const n = Math.floor(Number(startedPlayers) || 0);
    return Math.max(0, 2 * (n - 1));
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
        await recordSettledMatch(client, {
            matchKey: key, winnerUserId: opts.winnerUserId, loserUserIds: opts.loserUserIds || [],
            prize: amount, payingPlayers: opts.startedPlayers
        });
        await client.query('COMMIT');
        return { status: 'credited', amount, balanceBefore: Number(before.rows[0].balance).toFixed(2), balanceAfter: Number(after.rows[0].balance).toFixed(2) };
    } catch (e) {
        await client.query('ROLLBACK').catch(function () {});
        throw e;
    } finally {
        client.release();
    }
}

// ── Settled-match record (creator program) ───────────────────────────────────
// One structured row per paid game, written inside the credit transaction right
// after the game_wins claim — exactly-once on the same key as the credit. Same
// tables (shared database) as FIFA and Pong write; identical idempotent DDL.
// Raw facts only. entries_charged is true when the entries were really paid
// (kurver-pay.js: match_payments rows with this game's key); otherwise
// entry_price / paying_players / entry_total / margin are the listed $2 × the
// accounts in the game and nothing was collected — readers must count only
// entries_charged = true for money really paid in.
const KURVER_ENTRY_PRICE = '2.00';

// The three services may start at the same moment: the DDL runs in one
// transaction behind a shared advisory lock, so they take turns.
const SETTLED_MIGRATION_LOCK = 727274;

async function migrateSettledMatches() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [SETTLED_MIGRATION_LOCK]);
        await client.query(`
            CREATE TABLE IF NOT EXISTS settled_matches (
                match_key        TEXT PRIMARY KEY,
                game             TEXT NOT NULL CHECK (game IN ('fifa','pong','kurver')),
                settled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
                winner_user_id   INTEGER NOT NULL REFERENCES users(id),
                prize            NUMERIC(10,2) NOT NULL,
                entry_price      NUMERIC(10,2) NOT NULL,
                paying_players   INTEGER NOT NULL,
                entry_total      NUMERIC(10,2) NOT NULL,
                margin           NUMERIC(10,2) NOT NULL,
                entries_charged  BOOLEAN NOT NULL DEFAULT false
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS settled_match_players (
                match_key  TEXT NOT NULL REFERENCES settled_matches(match_key),
                user_id    INTEGER NOT NULL REFERENCES users(id),
                outcome    TEXT NOT NULL CHECK (outcome IN ('won','lost')),
                PRIMARY KEY (match_key, user_id)
            )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS settled_match_players_user_idx ON settled_match_players (user_id)`);
        await client.query('COMMIT');
        console.log('[settled-matches] tables ready');
    } catch (e) {
        await client.query('ROLLBACK').catch(function () {});
        console.error('[settled-matches] migration failed — games won\'t be recorded until this is fixed:', e);
    } finally {
        client.release();
    }
}
if (process.env.DATABASE_URL) { migrateSettledMatches(); }

// Inside the credit transaction, in its own savepoint: a failure skips only the
// record (logged) — the credit always commits.
async function recordSettledMatch(client, m) {
    await client.query('SAVEPOINT settled_match');
    try {
        const hasPayments = (await client.query(`SELECT to_regclass('public.match_payments') AS t`)).rows[0].t;
        const paidEntries = hasPayments
            ? (await client.query(`SELECT COUNT(*)::int AS n FROM match_payments WHERE match_key = $1 AND status = 'paid'`, [m.matchKey])).rows[0].n
            : 0;
        await client.query(
            `INSERT INTO settled_matches (match_key, game, winner_user_id, prize, entry_price, paying_players, entry_total, margin, entries_charged)
             VALUES ($1, 'kurver', $2, $3::numeric, $4::numeric, $5::int, $4::numeric * $5::int, $4::numeric * $5::int - $3::numeric, $6)
             ON CONFLICT (match_key) DO NOTHING`,
            [m.matchKey, m.winnerUserId, m.prize, KURVER_ENTRY_PRICE, paidEntries > 0 ? paidEntries : m.payingPlayers, paidEntries > 0]
        );
        await client.query(`INSERT INTO settled_match_players (match_key, user_id, outcome) VALUES ($1, $2, 'won') ON CONFLICT DO NOTHING`, [m.matchKey, m.winnerUserId]);
        for (const id of m.loserUserIds) {
            await client.query(`INSERT INTO settled_match_players (match_key, user_id, outcome) VALUES ($1, $2, 'lost') ON CONFLICT DO NOTHING`, [m.matchKey, id]);
        }
        await client.query('RELEASE SAVEPOINT settled_match');
    } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT settled_match').catch(function () {});
        console.error('[settled-matches] couldn\'t record ' + m.matchKey + ' (the credit is unaffected):', e);
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

module.exports = { authenticate, authenticateUpgrade, AuthError, prize, payoutsEnabled, newGameKey, creditWin, creditWinWithRetry, pool, migrateSettledMatches };
