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

// Returns 'unset' when ADMIN_PASSWORD is missing, otherwise true/false.
function checkPassword(req) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) return 'unset';
  const given = String(req.headers['x-admin-password'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(String(real)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Atomic balance change: refuses to go below zero, so two stations can never
// overwrite each other or overspend a kid's points.
const CHANGE_SCRIPT = `
local b = redis.call('HGET', KEYS[1], 'balance')
if not b then return {-1, 0} end
local nb = tonumber(b) + tonumber(ARGV[1])
if nb < 0 then return {-2, tonumber(b)} end
redis.call('HSET', KEYS[1], 'balance', nb)
return {1, nb}
`;

async function change(tag, delta, label, kind) {
  const r = await redis.eval(CHANGE_SCRIPT, ['kid:' + tag], [String(delta)]);
  const code = Number(r[0]);
  const bal = Number(r[1]);
  if (code === -1) throw httpErr(404, 'That wristband is not registered.');
  if (code === -2) {
    const name = await redis.hget('kid:' + tag, 'name');
    throw httpErr(409, name + ' has ' + bal + ' points and needs ' + (-delta) + '.');
  }
  const name = await redis.hget('kid:' + tag, 'name');
  const entry = JSON.stringify({ tag, name, delta, balance: bal, label, kind, ts: Date.now() });
  const p = redis.pipeline();
  p.lpush('ledger', entry);
  p.ltrim('ledger', 0, 4999);
  p.lpush('recent:' + tag, entry);
  p.ltrim('recent:' + tag, 0, 5);
  await p.exec();
  return bal;
}

module.exports = { redis, TAG_RE, toObj, httpErr, checkPassword, change };
