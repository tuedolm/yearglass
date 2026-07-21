/**
 * Yearglass analytics collector — Cloudflare Worker + D1.
 *
 * Receives the tiny JSON events the client's track() sends and stores them in
 * a D1 database. GET /stats returns per-puzzle aggregates as JSON — the score
 * distributions that tune the decay constant and difficulty curve (PRD §8).
 *
 * Privacy: no cookies, no user identifiers, no IPs stored. Each row is an
 * anonymous event. Keep it that way — it is why the game needs no consent UI.
 *
 * Events accepted (see track() in app.js):
 *   {e:"visit",    d:"2026-07-21", n:1}            // once per browser per day
 *   {e:"round",    d:"2026-07-21", n:1, r:1, err:4, pts:3567, hint:0}
 *   {e:"complete", d:"2026-07-21", n:1, total:15573}
 *   {e:"hint",     d:"2026-07-21", n:1, r:2}
 *   {e:"share",    d:"2026-07-21", n:1}
 *
 * Setup (one-time):
 *   npx wrangler d1 create yearglass-analytics   # id goes in wrangler.toml
 *   npx wrangler d1 execute yearglass-analytics --remote --command \
 *     "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, \
 *      e TEXT, d TEXT, n INTEGER, r INTEGER, err INTEGER, pts INTEGER, \
 *      hint INTEGER, ts INTEGER)"
 *   npx wrangler deploy -c infra/wrangler.toml
 * Then set CONFIG.analyticsEndpoint in app.js to the worker URL.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const KINDS = ["visit", "round", "complete", "hint", "share"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const completes = await env.DB.prepare(
        "SELECT n, COUNT(*) AS plays, ROUND(AVG(pts)) AS avg_total, " +
        "MIN(pts) AS min_total, MAX(pts) AS max_total " +
        "FROM events WHERE e='complete' GROUP BY n ORDER BY n"
      ).all();
      const rounds = await env.DB.prepare(
        "SELECT n, r, COUNT(*) AS guesses, ROUND(AVG(err), 1) AS avg_err, " +
        "ROUND(AVG(pts)) AS avg_pts, SUM(hint) AS hints, " +
        "SUM(CASE WHEN err <= 2 THEN 1 ELSE 0 END) AS within2 " +
        "FROM events WHERE e='round' GROUP BY n, r ORDER BY n, r"
      ).all();
      const shares = await env.DB.prepare(
        "SELECT n, COUNT(*) AS shares FROM events WHERE e='share' GROUP BY n ORDER BY n"
      ).all();
      // Daily actives: visitors = distinct browsers that opened the game that
      // day (client fires "visit" once per browser per day); plays = finished
      // games. visitors − plays ≈ people who bounced or didn't finish.
      const daily = await env.DB.prepare(
        "SELECT d, " +
        "SUM(CASE WHEN e='visit' THEN 1 ELSE 0 END) AS visitors, " +
        "SUM(CASE WHEN e='complete' THEN 1 ELSE 0 END) AS plays " +
        "FROM events WHERE e IN ('visit','complete') GROUP BY d ORDER BY d"
      ).all();
      return new Response(
        JSON.stringify({ daily: daily.results, puzzles: completes.results, rounds: rounds.results, shares: shares.results }, null, 2),
        { headers: { ...CORS, "content-type": "application/json" } },
      );
    }

    if (request.method !== "POST") {
      return new Response("POST an event or GET /stats", { status: 405, headers: CORS });
    }

    let ev;
    try {
      ev = await request.json();
    } catch {
      return new Response("bad json", { status: 400, headers: CORS });
    }
    if (!KINDS.includes(ev.e)) {
      return new Response("unknown event", { status: 400, headers: CORS });
    }

    await env.DB.prepare(
      "INSERT INTO events (e, d, n, r, err, pts, hint, ts) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(
      String(ev.e),
      String(ev.d || ""),
      Number(ev.n || 0),
      Number(ev.r || 0),
      Number.isFinite(ev.err) ? Number(ev.err) : null,
      Number.isFinite(ev.pts) ? Number(ev.pts) : (Number.isFinite(ev.total) ? Number(ev.total) : null),
      Number(ev.hint || 0),
      Date.now(),
    ).run();

    return new Response("ok", { headers: CORS });
  },
};
