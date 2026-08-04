const crypto = require('crypto');
const { BOT_TOKEN } = require('./env');

// Build a data-check-string from all initData fields (except hash), sorted
// alphabetically as "key=value" joined by "\n", then HMAC-SHA256 it with a
// derived secret key (same scheme as Telegram Mini Apps):
//   secretKey = HMAC_SHA256("WebAppData", botToken)
//   hash = HMAC_SHA256(secretKey, dataCheckString)
// Confirmed against a real signed payload captured from inside MAX.
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

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
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
