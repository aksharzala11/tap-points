const { redis, TAG_RE, toObj, httpErr, getRole, change } = require('./_lib');

const MAX_POINTS = 100000;
const STAFF_MAX = 1000;
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);
const cleanTag = (v) => String(v || '').trim().toLowerCase();
const need = (cond, msg, status) => {
  if (!cond) throw httpErr(status || 400, msg);
};
const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
const nums = (o) => {
  const out = {};
  Object.keys(o || {}).forEach((k) => (out[k] = Number(o[k]) || 0));
  return out;
};

async function exists(key) {
  return Number(await redis.exists(key)) > 0;
}

async function readMenu() {
  try {
    const m = JSON.parse((await redis.get('menu')) || '[]');
    return Array.isArray(m) ? m : [];
  } catch (_) {
    return [];
  }
}

// First scan of an unknown wristband: create the kid automatically.
// The name is a placeholder like "Kid 3F9A1"; an admin can rename it later.
async function ensureKid(tag) {
  const alnum = tag.replace(/[^a-z0-9]/g, '').toUpperCase();
  const name = 'Kid ' + (alnum.slice(-5) || 'NEW');
  const made = Number(await redis.hsetnx('kid:' + tag, 'name', name)) === 1;
  if (!made) return false;
  const p = redis.pipeline();
  p.hset('kid:' + tag, { tag, created: Date.now() });
  p.hsetnx('kid:' + tag, 'balance', 0);
  p.hset('idx', { [tag]: name });
  p.hsetnx('bal', tag, 0);
  p.sadd('kids', tag);
  await p.exec();
  return true;
}

// Rebuild the quick name and balance indexes from the kid records.
async function rebuild() {
  const tags = await redis.smembers('kids');
  let rows = [];
  if (tags.length) {
    const p = redis.pipeline();
    tags.forEach((t) => p.hgetall('kid:' + t));
    rows = (await p.exec()).map(toObj);
  }
  const p2 = redis.pipeline();
  p2.del('idx');
  p2.del('bal');
  rows.forEach((h, i) => {
    if (h && h.name) {
      p2.hset('idx', { [h.tag || tags[i]]: h.name });
      p2.hset('bal', { [h.tag || tags[i]]: Number(h.balance) || 0 });
    } else {
      p2.srem('kids', tags[i]);
    }
  });
  await p2.exec();
}

// What each action needs: 'staff' (helpers and admin) or 'admin' (admin only).
const NEEDS = {
  whoami: 'staff',
  menu: 'staff',
  lookup: 'staff',
  find: 'staff',
  change: 'staff',
  list: 'admin',
  register: 'admin',
  rename: 'admin',
  remove: 'admin',
  relink: 'admin',
  setMenu: 'admin',
};

const actions = {
  async whoami(b, role) {
    return { role };
  },

  async menu() {
    return { items: await readMenu() };
  },

  // One kid by wristband, for the checkout screen.
  async lookup(b) {
    const tag = cleanTag(b.tag);
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    const isNew = await ensureKid(tag);
    const p = redis.pipeline();
    p.hget('kid:' + tag, 'name');
    p.hget('kid:' + tag, 'balance');
    const [name, balance] = await p.exec();
    if (!name) return { found: false };
    return { found: true, tag, name, balance: Number(balance) || 0, isNew };
  },

  // Name search for helpers. Returns at most 8 kids, never the full roster.
  async find(b) {
    const q = String(b.q || '').trim().toLowerCase().slice(0, 40);
    if (!q) return { matches: [] };
    const idx = toObj(await redis.hgetall('idx')) || {};
    const hits = Object.keys(idx)
      .filter((t) => String(idx[t]).toLowerCase().includes(q) || t.includes(q))
      .map((t) => ({ tag: t, name: idx[t] }))
      .sort(byName)
      .slice(0, 8);
    if (hits.length) {
      const p = redis.pipeline();
      hits.forEach((h) => p.hget('bal', h.tag));
      const bals = await p.exec();
      hits.forEach((h, i) => (h.balance = Number(bals[i]) || 0));
    }
    return { matches: hits };
  },

  // Positive delta awards points, negative delta charges them.
  async change(b, role) {
    const tag = cleanTag(b.tag);
    const delta = int(b.delta);
    const limit = role === 'admin' ? MAX_POINTS : STAFF_MAX;
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    need(Number.isFinite(delta) && delta !== 0, 'Points must be a whole number.');
    need(Math.abs(delta) <= limit, 'That is more than ' + limit + ' points. Ask an admin.', 403);
    const label = String(b.label || (delta > 0 ? 'Points' : 'Purchase')).trim().slice(0, 80) || 'Points';
    let kind = delta > 0 ? 'earn' : 'spend';
    if (b.kind === 'adjust') {
      need(role === 'admin', 'Corrections need the admin password.', 403);
      kind = 'adjust';
    }
    let items = [];
    if (kind === 'spend' && Array.isArray(b.items)) {
      items = b.items.slice(0, 20).map((i) => ({
        name: String(i.name || '').trim().slice(0, 40),
        qty: int(i.qty),
        cost: int(i.cost),
      }));
      items = items.filter((i) => i.name && i.qty > 0 && i.qty <= 99 && i.cost > 0 && i.cost <= MAX_POINTS);
    }
    await ensureKid(tag);
    return change(tag, delta, label, kind, items);
  },

  // Everything the admin dashboard needs, in a fixed handful of commands.
  async list() {
    const [nIdx, nSet] = [Number(await redis.hlen('idx')), Number(await redis.scard('kids'))];
    if (nIdx !== nSet) await rebuild();
    const idx = toObj(await redis.hgetall('idx')) || {};
    const bal = toObj(await redis.hgetall('bal')) || {};
    const kids = Object.keys(idx).map((tag) => ({ tag, name: idx[tag], balance: Number(bal[tag]) || 0 }));
    const ledger = (await redis.lrange('ledger', 0, 29))
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    const s = nums(toObj(await redis.hgetall('stats')));
    const stations = nums(toObj(await redis.hgetall('stats:stations')));
    const itemQty = nums(toObj(await redis.hgetall('stats:items')));
    const itemPts = nums(toObj(await redis.hgetall('stats:itempts')));
    const items = {};
    Object.keys(itemQty).forEach((n) => (items[n] = { qty: itemQty[n], pts: itemPts[n] || 0 }));
    return {
      kids,
      ledger,
      menu: await readMenu(),
      stats: { earned: s.earned || 0, spent: s.spent || 0, tx: s.tx || 0, stations, items },
    };
  },

  async register(b) {
    const tag = cleanTag(b.tag);
    const name = String(b.name || '').trim().slice(0, 60);
    const start = int(b.start || 0);
    need(name, 'Enter a name.');
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    need(Number.isFinite(start) && start >= 0 && start <= MAX_POINTS, 'Starting points must be zero or more.');
    if (await exists('kid:' + tag)) {
      const other = await redis.hget('kid:' + tag, 'name');
      throw httpErr(409, 'That wristband already belongs to ' + other + '.');
    }
    const p = redis.pipeline();
    p.hset('kid:' + tag, { name, tag, balance: 0, created: Date.now() });
    p.hset('idx', { [tag]: name });
    p.hset('bal', { [tag]: 0 });
    p.sadd('kids', tag);
    await p.exec();
    if (start > 0) await change(tag, start, 'Starting points', 'adjust');
    return {};
  },

  async rename(b) {
    const tag = cleanTag(b.tag);
    const name = String(b.name || '').trim().slice(0, 60);
    need(name, 'Enter a name.');
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    need(await exists('kid:' + tag), 'Kid not found.', 404);
    const p = redis.pipeline();
    p.hset('kid:' + tag, { name });
    p.hset('idx', { [tag]: name });
    await p.exec();
    return {};
  },

  async remove(b) {
    const tag = cleanTag(b.tag);
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    const p = redis.pipeline();
    p.del('kid:' + tag);
    p.del('recent:' + tag);
    p.hdel('idx', tag);
    p.hdel('bal', tag);
    p.srem('kids', tag);
    await p.exec();
    return {};
  },

  // Move a kid (name, points, history) onto a different wristband.
  async relink(b) {
    const oldTag = cleanTag(b.tag);
    const newTag = cleanTag(b.newTag);
    need(TAG_RE.test(oldTag) && TAG_RE.test(newTag), 'Bad wristband ID.');
    need(oldTag !== newTag, 'That is already this kid’s wristband.');
    need(await exists('kid:' + oldTag), 'Kid not found.', 404);
    if (await exists('kid:' + newTag)) {
      const other = await redis.hget('kid:' + newTag, 'name');
      throw httpErr(409, 'That wristband already belongs to ' + other + '.');
    }
    await redis.rename('kid:' + oldTag, 'kid:' + newTag);
    await redis.hset('kid:' + newTag, { tag: newTag });
    if (await exists('recent:' + oldTag)) await redis.rename('recent:' + oldTag, 'recent:' + newTag);
    const nm = await redis.hget('kid:' + newTag, 'name');
    const bl = await redis.hget('kid:' + newTag, 'balance');
    const p = redis.pipeline();
    p.hdel('idx', oldTag);
    p.hdel('bal', oldTag);
    p.hset('idx', { [newTag]: nm });
    p.hset('bal', { [newTag]: Number(bl) || 0 });
    p.srem('kids', oldTag);
    p.sadd('kids', newTag);
    await p.exec();
    return {};
  },

  async setMenu(b) {
    need(Array.isArray(b.items) && b.items.length <= 60, 'Menu must be a list of up to 60 items.');
    const items = b.items.map((i) => ({ name: String(i.name || '').trim().slice(0, 40), cost: int(i.cost) }));
    need(items.every((i) => i.name && Number.isFinite(i.cost) && i.cost > 0 && i.cost <= MAX_POINTS), 'Each item needs a name and a cost above zero.');
    await redis.set('menu', JSON.stringify(items));
    return { items };
  },

};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const role = getRole(req);
    if (role === 'unset') {
      return res.status(500).json({ error: 'ADMIN_PASSWORD is not set. Add it in Vercel under Settings, Environment Variables, then redeploy.' });
    }
    if (!role) {
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ error: 'Wrong password.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const name = Object.prototype.hasOwnProperty.call(actions, body.action) ? body.action : null;
    if (!name) return res.status(400).json({ error: 'Unknown action.' });
    if (NEEDS[name] === 'admin' && role !== 'admin') {
      return res.status(403).json({ error: 'This needs the admin password.' });
    }
    return res.status(200).json(await actions[name](body, role));
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    const message = e && e.status ? e.message : 'The database did not answer. Check that Upstash Redis is connected to this project.';
    return res.status(status).json({ error: message });
  }
};
