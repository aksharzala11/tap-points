const { redis, TAG_RE, toObj } = require('./_lib');

// Public: a kid taps their wristband and sees their own name and balance.
// There is deliberately no way to list or search kids here.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const tag = String((req.query && req.query.tag) || '').trim().toLowerCase();
  if (!TAG_RE.test(tag)) return res.status(200).json({ found: false });
  try {
    const k = toObj(await redis.hgetall('kid:' + tag));
    // Unknown wristband: show a fresh 0 balance. It is added to the system on its first award.
    if (!k || !k.name) return res.status(200).json({ found: true, name: '', balance: 0, recent: [] });
    const raw = await redis.lrange('recent:' + tag, 0, 5);
    const recent = raw
      .map((s) => {
        try {
          const e = JSON.parse(s);
          return { d: e.delta, l: e.label, t: e.ts };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    return res.status(200).json({ found: true, name: k.name, balance: Number(k.balance), recent });
  } catch (e) {
    return res.status(500).json({ error: 'Could not reach the database.' });
  }
};
