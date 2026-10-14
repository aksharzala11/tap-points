const { redis, TAG_RE, toObj, httpErr, checkPassword, change } = require('./_lib');

const MAX_POINTS = 100000;
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : NaN);
const cleanTag = (v) => String(v || '').trim().toLowerCase();
const need = (cond, msg, status) => {
  if (!cond) throw httpErr(status || 400, msg);
};

async function exists(key) {
  return Number(await redis.exists(key)) > 0;
}

const actions = {
  // Everything the staff screens need in one call.
  async list() {
    const tags = await redis.smembers('kids');
    let kids = [];
    if (tags.length) {
      const p = redis.pipeline();
      tags.forEach((t) => p.hgetall('kid:' + t));
      const rows = await p.exec();
      kids = rows
        .map(toObj)
        .filter((h) => h && h.name)
        .map((h) => ({ tag: h.tag, name: h.name, balance: Number(h.balance) }));
    }
    const ledger = (await redis.lrange('ledger', 0, 29))
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    let menu = [];
    try {
      menu = JSON.parse((await redis.get('menu')) || '[]');
    } catch (_) {}
    return { kids, ledger, menu };
  },

  // Positive delta awards points, negative delta charges them.
  async change(b) {
    const tag = cleanTag(b.tag);
    const delta = int(b.delta);
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    need(Number.isFinite(delta) && delta !== 0 && Math.abs(delta) <= MAX_POINTS, 'Points must be a whole number.');
    const label = String(b.label || (delta > 0 ? 'Points' : 'Purchase')).slice(0, 80);
    const balance = await change(tag, delta, label, delta > 0 ? 'earn' : 'spend');
    return { balance };
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
    await redis.hset('kid:' + tag, { name, tag, balance: 0, created: Date.now() });
    await redis.sadd('kids', tag);
    if (start > 0) await change(tag, start, 'Starting points', 'earn');
    return {};
  },

  async rename(b) {
    const tag = cleanTag(b.tag);
    const name = String(b.name || '').trim().slice(0, 60);
    need(name, 'Enter a name.');
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    need(await exists('kid:' + tag), 'Kid not found.', 404);
    await redis.hset('kid:' + tag, { name });
    return {};
  },

  async remove(b) {
    const tag = cleanTag(b.tag);
    need(TAG_RE.test(tag), 'Bad wristband ID.');
    const p = redis.pipeline();
    p.del('kid:' + tag);
    p.del('recent:' + tag);
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
    const p = redis.pipeline();
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

  // One-time starter data for trying the system out.
  async seed() {
    need(Number(await redis.scard('kids')) === 0, 'Remove all kids before loading test data.', 409);
    const p = redis.pipeline();
    for (let i = 1; i <= 5; i++) {
      p.hset('kid:test-' + i, { name: 'Test ' + i, tag: 'test-' + i, balance: 0, created: Date.now() });
      p.sadd('kids', 'test-' + i);
    }
    p.set('menu', JSON.stringify([
      { name: 'Candy 1', cost: 25 },
      { name: 'Candy 2', cost: 15 },
      { name: 'Prize 1', cost: 5 },
      { name: 'Prize 2', cost: 20 },
    ]));
    await p.exec();
    return {};
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  try {
    const ok = checkPassword(req);
    if (ok === 'unset') {
      return res.status(500).json({ error: 'ADMIN_PASSWORD is not set. Add it in Vercel under Settings, Environment Variables, then redeploy.' });
    }
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600));
      return res.status(401).json({ error: 'Wrong password.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const fn = Object.prototype.hasOwnProperty.call(actions, body.action) ? actions[body.action] : null;
    if (!fn) return res.status(400).json({ error: 'Unknown action.' });
    return res.status(200).json(await fn(body));
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    const message = e && e.status ? e.message : 'The database did not answer. Check that Upstash Redis is connected to this project.';
    return res.status(status).json({ error: message });
  }
};
