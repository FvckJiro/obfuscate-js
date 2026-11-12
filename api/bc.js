// BlackClover backend: one Vercel function, data in Upstash Redis (Vercel KV).
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (set by the Vercel Redis integration), ADMIN_PASSWORD (you choose it).
// Optional env: CHECKPOINT_STEPS (default 3), CHECKPOINT_WAIT seconds per step (default 12), KEY_HOURS (default 24).
const crypto = require("crypto");

const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN = process.env.ADMIN_PASSWORD || "";
const STEPS = Math.max(1, Math.min(8, +process.env.CHECKPOINT_STEPS || 3));
const WAIT = Math.max(3, Math.min(120, +process.env.CHECKPOINT_WAIT || 12));
const KEY_HOURS = Math.max(1, Math.min(720, +process.env.KEY_HOURS || 24));
const RESERVED = ["admin", "administrator", "blackclover", "staff", "mod", "moderator", "support", "system", "owner", "dev"];

const J = s => { try { return JSON.parse(s); } catch (e) { return null; } };
async function R(...cmd) {
  const res = await fetch(U, { method: "POST", headers: { Authorization: "Bearer " + T }, body: JSON.stringify(cmd) });
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const pairs = a => { const o = {}; for (let i = 0; i < (a || []).length; i += 2) o[a[i]] = a[i + 1]; return o; };
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString("hex");
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const fail = (res, code, error) => res.status(code).json({ error });
const authorsMap = A => { const o = {}; for (const [k, v] of Object.entries(pairs(A))) o[k] = J(v) || {}; return o; };
const ipOf = req => String(req.headers["x-vercel-forwarded-for"] || req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "x").split(",")[0].trim().slice(0, 45);
const jpg = (s, max) => { const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || "")); return m && m[1].length <= max ? m[1] : null; };

// true while the caller is still under the limit
async function limit(key, max, secs) {
  const k = "bc:rl:" + key;
  const n = await R("INCR", k);
  if (n === 1) await R("EXPIRE", k, secs);
  return n <= max;
}

function shape(p, au, st) {
  const a = au[p.author.toLowerCase()];
  return {
    id: p.id, title: p.title, author: p.author, verified: !!(a && a.verified), av: (a && a.p && a.p.av) || 0,
    game: p.game, placeId: p.placeId, tags: p.tags, desc: p.desc, hasImg: p.hasImg, at: p.at, status: p.status,
    views: +(st["v:" + p.id] || 0), likes: +(st["l:" + p.id] || 0)
  };
}
// public view of an account: never includes salt or hash
function pub(rec) {
  const p = rec.p || {};
  return {
    name: rec.name, verified: !!rec.verified, joined: rec.at || 0,
    display: p.display || "", bio: p.bio || "", accent: p.accent || "", discord: p.discord || "", game: p.game || "",
    av: p.av || 0, bn: p.bn || 0
  };
}
const totalsOf = list => list.reduce((t, p) => { if (p.status === "approved") { t.posts++; t.views += p.views; t.likes += p.likes; } else if (p.status === "pending") t.pending++; return t; }, { posts: 0, views: 0, likes: 0, pending: 0 });
const allPosts = async () => Object.values(pairs(await R("HGETALL", "bc:posts"))).map(J).filter(Boolean);

async function newSession(key) {
  const token = crypto.randomBytes(24).toString("hex");
  await R("SET", "bc:s:" + sha(token), key, "EX", 60 * 60 * 24 * 30);
  return token;
}
async function who(req) {
  const t = String(req.headers["x-token"] || "");
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  const key = await R("GET", "bc:s:" + sha(t));
  if (!key) return null;
  const rec = J(await R("HGET", "bc:authors", key));
  return rec ? { key, rec } : null;
}
async function removePost(id) {
  await R("HDEL", "bc:posts", id);
  await R("HDEL", "bc:img", id);
  await R("HDEL", "bc:stats", "v:" + id, "l:" + id);
  await R("DEL", "bc:v:" + id, "bc:l:" + id);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!U || !T) return fail(res, 503, "storage_not_configured");
  const q = req.query || {};
  const a = String(q.a || "");
  let b = req.body;
  if (typeof b === "string") b = J(b);
  b = b || {};
  const post = req.method === "POST";
  const ip = ipOf(req);
  const isAdmin = !!ADMIN && same(req.headers["x-admin"] || "", ADMIN);

  try {
    /* ---------- images ---------- */
    if (a === "img" || a === "avatar" || a === "banner") {
      const field = a === "img" ? clean(q.id, 20) : clean(q.u, 20).toLowerCase();
      const d = await R("HGET", a === "img" ? "bc:img" : "bc:" + a, field);
      if (!d) return fail(res, 404, "not_found");
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.status(200).end(Buffer.from(d, "base64"));
    }

    /* ---------- public scripts ---------- */
    if (a === "list") {
      const [ps, A, S] = await Promise.all([allPosts(), R("HGETALL", "bc:authors"), R("HGETALL", "bc:stats")]);
      const au = authorsMap(A), st = pairs(S);
      return res.json({ posts: ps.filter(p => p.status === "approved").map(p => shape(p, au, st)) });
    }

    if (a === "get" && post) {
      const id = clean(b.id, 20), cid = clean(b.cid, 64);
      const p = J(await R("HGET", "bc:posts", id));
      if (!p || (p.status !== "approved" && !isAdmin)) return fail(res, 404, "not_found");
      if (cid && (await R("SADD", "bc:v:" + id, cid)) === 1) await R("HINCRBY", "bc:stats", "v:" + id, 1);
      const [A, S, liked] = await Promise.all([R("HGETALL", "bc:authors"), R("HGETALL", "bc:stats"), R("SISMEMBER", "bc:l:" + id, cid || "-")]);
      return res.json({ post: { ...shape(p, authorsMap(A), pairs(S)), code: p.code }, liked: liked === 1 });
    }

    if (a === "like" && post) {
      const id = clean(b.id, 20), cid = clean(b.cid, 64);
      if (!cid) return fail(res, 400, "bad_request");
      if (!(await limit("like:" + ip, 120, 600))) return fail(res, 429, "slow_down");
      const p = J(await R("HGET", "bc:posts", id));
      if (!p || p.status !== "approved") return fail(res, 404, "not_found");
      let liked = true;
      if ((await R("SADD", "bc:l:" + id, cid)) === 1) await R("HINCRBY", "bc:stats", "l:" + id, 1);
      else { await R("SREM", "bc:l:" + id, cid); await R("HINCRBY", "bc:stats", "l:" + id, -1); liked = false; }
      return res.json({ liked, likes: +(await R("HGET", "bc:stats", "l:" + id)) || 0 });
    }

    /* ---------- accounts ---------- */
    if (a === "register" && post) {
      if (!(await limit("reg:" + ip, 5, 3600))) return fail(res, 429, "slow_down");
      const name = clean(b.name, 20), pass = String(b.pass || "");
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(name)) return fail(res, 400, "bad_author");
      if (pass.length < 6 || pass.length > 64) return fail(res, 400, "bad_pass");
      const key = name.toLowerCase();
      if (RESERVED.includes(key)) return fail(res, 409, "name_taken");
      const salt = crypto.randomBytes(12).toString("hex");
      const rec = { name, salt, hash: hash(pass, salt), verified: false, at: Date.now(), p: {} };
      if ((await R("HSETNX", "bc:authors", key, JSON.stringify(rec))) !== 1) return fail(res, 409, "name_taken");
      return res.json({ token: await newSession(key), me: pub(rec) });
    }

    if (a === "login" && post) {
      const key = clean(b.name, 20).toLowerCase(), pass = String(b.pass || "");
      if (!(await limit("login:" + ip, 20, 600)) || !(await limit("loginn:" + key, 10, 600))) return fail(res, 429, "slow_down");
      const rec = J(await R("HGET", "bc:authors", key));
      const ok = same(hash(pass.slice(0, 64), rec ? rec.salt : "00"), rec ? rec.hash : "x");
      if (!rec || !ok) return fail(res, 403, "wrong_login");
      return res.json({ token: await newSession(key), me: pub(rec) });
    }

    if (a === "logout" && post) {
      const t = String(req.headers["x-token"] || "");
      if (/^[a-f0-9]{48}$/.test(t)) await R("DEL", "bc:s:" + sha(t));
      return res.json({ ok: true });
    }

    if (a === "profile") {
      const key = clean(q.u, 20).toLowerCase();
      const rec = key && J(await R("HGET", "bc:authors", key));
      if (!rec) return fail(res, 404, "not_found");
      const [ps, S] = await Promise.all([allPosts(), R("HGETALL", "bc:stats")]);
      const st = pairs(S), au = { [key]: rec };
      const mine = ps.filter(p => p.author.toLowerCase() === key && p.status === "approved").sort((x, y) => y.at - x.at).map(p => shape(p, au, st));
      return res.json({ user: pub(rec), posts: mine, totals: totalsOf(mine) });
    }

    /* ---------- signed-in routes ---------- */
    const SIGNED = ["me", "mine", "mydel", "profile_set", "post"];
    let me = null;
    if (SIGNED.includes(a)) {
      me = await who(req);
      if (!me) return fail(res, 401, "login_required");
    }

    if (a === "me") return res.json({ me: pub(me.rec) });

    if (a === "mine") {
      const [ps, S] = await Promise.all([allPosts(), R("HGETALL", "bc:stats")]);
      const st = pairs(S), au = { [me.key]: me.rec };
      const list = ps.filter(p => p.author.toLowerCase() === me.key).sort((x, y) => y.at - x.at).map(p => shape(p, au, st));
      return res.json({ me: pub(me.rec), posts: list, totals: totalsOf(list) });
    }

    if (a === "mydel" && post) {
      const id = clean(b.id, 20);
      const p = J(await R("HGET", "bc:posts", id));
      if (!p || p.author.toLowerCase() !== me.key) return fail(res, 404, "not_found");
      await removePost(id);
      return res.json({ ok: true });
    }

    if (a === "profile_set" && post) {
      const rec = me.rec, p = rec.p || {};
      p.display = clean(b.display, 24);
      p.bio = clean(b.bio, 240);
      p.discord = clean(b.discord, 40);
      p.game = clean(b.game, 40);
      const accent = String(b.accent || "").trim();
      if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) return fail(res, 400, "bad_color");
      p.accent = accent.toLowerCase();
      if (b.avatar) {
        const img = jpg(b.avatar, 70000);
        if (!img) return fail(res, 400, "bad_image");
        await R("HSET", "bc:avatar", me.key, img); p.av = Date.now();
      } else if (b.removeAvatar) { await R("HDEL", "bc:avatar", me.key); p.av = 0; }
      if (b.banner) {
        const img = jpg(b.banner, 220000);
        if (!img) return fail(res, 400, "bad_image");
        await R("HSET", "bc:banner", me.key, img); p.bn = Date.now();
      } else if (b.removeBanner) { await R("HDEL", "bc:banner", me.key); p.bn = 0; }
      rec.p = p;
      await R("HSET", "bc:authors", me.key, JSON.stringify(rec));
      return res.json({ me: pub(rec) });
    }

    if (a === "post" && post) {
      const title = clean(b.title, 60), game = clean(b.game, 60), placeId = String(b.placeId || "").trim(), desc = clean(b.desc, 600);
      const code = String(b.code || "").replace(/\r\n/g, "\n");
      const tags = [...new Set(String(b.tags || "").toLowerCase().split(",").map(t => t.trim().replace(/[^a-z0-9 _-]/g, "").slice(0, 16)).filter(Boolean))].slice(0, 5);
      if (title.length < 3) return fail(res, 400, "bad_title");
      if (game.length < 2) return fail(res, 400, "bad_game");
      if (!/^\d{1,15}$/.test(placeId)) return fail(res, 400, "bad_place");
      if (code.trim().length < 10 || code.length > 20000) return fail(res, 400, "bad_code");
      let img = "";
      if (b.image) {
        img = jpg(b.image, 260000);
        if (!img) return fail(res, 400, "bad_image");
      }
      if (!(await limit("post:" + me.key, 20, 3600))) return fail(res, 429, "slow_down");
      if (!me.rec.verified) {
        const waiting = (await allPosts()).filter(p => p.author.toLowerCase() === me.key && p.status === "pending").length;
        if (waiting >= 5) return fail(res, 429, "too_many_pending");
      }
      const id = crypto.randomBytes(5).toString("hex");
      const status = me.rec.verified ? "approved" : "pending";
      const p = { id, title, author: me.rec.name, game, placeId, tags, desc, code, hasImg: !!img, at: Date.now(), status };
      await R("HSET", "bc:posts", id, JSON.stringify(p));
      if (img) await R("HSET", "bc:img", id, img);
      return res.json({ ok: true, id, status });
    }

    /* ---------- key checkpoint ---------- */
    if (a === "check") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (!(await limit("chk:" + ip, 120, 60))) return fail(res, 429, "slow_down");
      const k = clean(q.k, 32).toUpperCase();
      const rec = k && J(await R("GET", "bc:key:" + k));
      if (!rec) return res.json({ valid: false });
      return res.json({ valid: true, exp: rec.exp });
    }

    if (a.startsWith("cp_") && post) {
      const cid = clean(b.cid, 64);
      if (!cid) return fail(res, 400, "bad_request");
      const view = async (st, extra) => {
        const left = st.t ? Math.max(0, Math.ceil((st.t + WAIT * 1000 - Date.now()) / 1000)) : WAIT;
        return { total: STEPS, wait: WAIT, step: st.step, opened: !!st.t, left, ...extra };
      };
      const done = async () => {
        const k = await R("GET", "bc:ck:" + cid);
        if (!k) return null;
        const rec = J(await R("GET", "bc:key:" + k));
        return rec ? { key: k, exp: rec.exp } : null;
      };
      const have = await done();
      if (have) return res.json(await view({ step: STEPS, t: 0 }, have));
      const st = J(await R("GET", "bc:cp:" + cid)) || { step: 0, t: 0 };

      if (a === "cp_state") return res.json(await view(st));

      if (a === "cp_open") {
        if (!st.t) st.t = Date.now();
        await R("SET", "bc:cp:" + cid, JSON.stringify(st), "EX", 3600);
        return res.json(await view(st));
      }

      if (a === "cp_next") {
        if (!st.t) return fail(res, 400, "not_opened");
        const v = await view(st);
        if (v.left > 0) return res.status(400).json({ error: "too_fast", left: v.left });
        st.step++; st.t = 0;
        if (st.step < STEPS) {
          await R("SET", "bc:cp:" + cid, JSON.stringify(st), "EX", 3600);
          return res.json(await view(st));
        }
        if (!(await limit("key:" + ip, 3, 86400))) return fail(res, 429, "key_limit");
        const hex = crypto.randomBytes(6).toString("hex").toUpperCase();
        const key = `BC-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
        const exp = Date.now() + KEY_HOURS * 3600 * 1000;
        await R("SET", "bc:key:" + key, JSON.stringify({ at: Date.now(), exp }), "EX", KEY_HOURS * 3600);
        await R("SET", "bc:ck:" + cid, key, "EX", KEY_HOURS * 3600);
        await R("DEL", "bc:cp:" + cid);
        return res.json(await view({ step: STEPS, t: 0 }, { key, exp }));
      }
    }

    /* ---------- admin ---------- */
    if (a.startsWith("admin_")) {
      if (!ADMIN) return fail(res, 503, "admin_not_configured");
      if (!isAdmin) {
        if (!(await limit("adm:" + ip, 15, 600))) return fail(res, 429, "slow_down");
        return fail(res, 401, "unauthorized");
      }

      if (a === "admin_list") {
        const [ps, A, S] = await Promise.all([allPosts(), R("HGETALL", "bc:authors"), R("HGETALL", "bc:stats")]);
        const au = authorsMap(A), st = pairs(S);
        const posts = ps.sort((x, y) => y.at - x.at).map(p => ({ ...shape(p, au, st), code: p.code }));
        const agg = {};
        for (const [k, v] of Object.entries(au)) agg[k] = { name: v.name || k, verified: !!v.verified, posts: 0, views: 0, likes: 0 };
        for (const p of posts) {
          const g = agg[p.author.toLowerCase()];
          if (g && p.status === "approved") { g.posts++; g.views += p.views; g.likes += p.likes; }
        }
        return res.json({ posts, authors: Object.values(agg) });
      }

      if (a === "admin_set" && post) {
        const id = clean(b.id, 20);
        const p = J(await R("HGET", "bc:posts", id));
        if (!p || !["approved", "rejected"].includes(b.status)) return fail(res, 400, "bad_request");
        p.status = b.status;
        await R("HSET", "bc:posts", id, JSON.stringify(p));
        return res.json({ ok: true });
      }

      if (a === "admin_del" && post) {
        await removePost(clean(b.id, 20));
        return res.json({ ok: true });
      }

      if (a === "admin_verify" && post) {
        const key = clean(b.author, 20).toLowerCase();
        const rec = J(await R("HGET", "bc:authors", key));
        if (!rec) return fail(res, 404, "not_found");
        rec.verified = !!b.verified;
        await R("HSET", "bc:authors", key, JSON.stringify(rec));
        return res.json({ ok: true });
      }
    }

    return fail(res, 404, "not_found");
  } catch (e) {
    return fail(res, 500, "server_error");
  }
};
