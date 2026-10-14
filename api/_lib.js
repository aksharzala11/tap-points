const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

// Vercel's Upstash integration sets KV_REST_API_* ; a direct Upstash setup sets UPSTASH_REDIS_REST_*.
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});

const TAG_RE = /^[a-z0-9:_.\-@+~]{1,100}$/;

// With automaticDeserialization off, HGETALL comes back as a flat list
// [field, value, field, value, ...]. Turn it into a plain object (or null when empty).
function toObj(raw) {
  if (!raw) return null;
  if (!Array.isArray(raw)) return Object.keys(raw).length ? raw : null;
  if (raw.length === 0) return null;
  const o = {};
  for (let i = 0; i + 1 < raw.length; i += 2) o[String(raw[i])] = raw[i + 1];
  return o;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// 'unset' when ADMIN_PASSWORD is missing, otherwise 'admin', 'staff' or false.
// STAFF_PASSWORD is optional; without it only the admin password works.
function getRole(req) {
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) return 'unset';
  const given = String(req.headers['x-admin-password'] || '');
  const isAdmin = same(given, adminPw);
  const staffPw = process.env.STAFF_PASSWORD;
  const isStaff = staffPw ? same(given, staffPw) : false;
  return isAdmin ? 'admin' : isStaff ? 'staff' : false;
}

// Atomic balance change. It refuses to go below zero, so two stations can never
// overwrite each other or overspend a kid's points. It also keeps the quick
// balance index ('bal') in step so the roster can load in a handful of commands.
const CHANGE_SCRIPT = `
local b = redis.call('HGET', KEYS[1], 'balance')
if not b then return {-1, 0} end
local nb = tonumber(b) + tonumber(ARGV[1])
if nb < 0 then return {-2, tonumber(b)} end
redis.call('HSET', KEYS[1], 'balance', nb)
redis.call('HSET', KEYS[2], ARGV[2], nb)
return {1, nb}
`;

// kind: 'earn' (game station), 'spend' (checkout) or 'adjust' (staff correction, not counted in stats)
async function change(tag, delta, label, kind, items) {
  const r = await redis.eval(CHANGE_SCRIPT, ['kid:' + tag, 'bal'], [String(delta), tag]);
  const code = Number(r[0]);
  const bal = Number(r[1]);
  if (code === -1) throw httpErr(404, 'That wristband is not registered.');
  if (code === -2) {
    const who = await redis.hget('kid:' + tag, 'name');
    throw httpErr(409, who + ' has ' + bal + ' points and needs ' + (-delta) + '.');
  }
  const name = await redis.hget('kid:' + tag, 'name');
  const abs = Math.abs(delta);
  const entry = JSON.stringify({ tag, name, delta, balance: bal, label, kind, ts: Date.now() });
  const p = redis.pipeline();
  p.lpush('ledger', entry);
  p.ltrim('ledger', 0, 4999);
  p.lpush('recent:' + tag, entry);
  p.ltrim('recent:' + tag, 0, 5);
  if (kind === 'earn') {
    p.hincrby('stats', 'tx', 1);
    p.hincrby('stats', 'earned', abs);
    p.hincrby('stats:stations', label, abs);
  } else if (kind === 'spend') {
    p.hincrby('stats', 'tx', 1);
    p.hincrby('stats', 'spent', abs);
    (items || []).forEach((i) => {
      p.hincrby('stats:items', i.name, i.qty);
      p.hincrby('stats:itempts', i.name, i.qty * i.cost);
    });
  }
  await p.exec();
  return { balance: bal, name };
}

module.exports = { redis, TAG_RE, toObj, httpErr, getRole, change };
