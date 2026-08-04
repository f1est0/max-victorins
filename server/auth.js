const crypto = require('crypto');
const { BOT_TOKEN } = require('./env');

// Per MAX Bridge docs: build a data-check-string from all initData fields
// (except hash), sorted alphabetically as "key=value" joined by "\n", then
// HMAC-SHA256 it using the bot token as the secret key.
// The docs only give a worked example for phone verification, not the full
// launch-data algorithm, so this is a best-effort implementation pending
// confirmation against a real signed payload from inside MAX.
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return { ok: false, reason: 'missing_data_or_token' };

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch (e) {
    return { ok: false, reason: 'parse_error' };
  }

  const receivedHash = params.get('hash');
  if (!receivedHash) return { ok: false, reason: 'no_hash' };
  params.delete('hash');

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const computedHash = crypto
    .createHmac('sha256', BOT_TOKEN)
    .update(dataCheckString)
    .digest('hex');

  const ok =
    computedHash.length === receivedHash.length &&
    crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(receivedHash));

  if (!ok) {
    console.warn('[auth] initData hash mismatch — algorithm may need adjustment', {
      dataCheckString,
      computedHash,
      receivedHash,
    });
    return { ok: false, reason: 'bad_hash' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (e) {
    // ignore
  }
  if (!user || !user.id) return { ok: false, reason: 'no_user' };

  return {
    ok: true,
    user: {
      id: user.id,
      firstName: user.first_name || '',
      lastName: user.last_name || '',
      username: user.username || '',
      photoUrl: user.photo_url || '',
    },
  };
}

module.exports = { verifyInitData };
