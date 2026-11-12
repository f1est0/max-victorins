const crypto = require('crypto');
const { BOT_TOKEN } = require('./env');

const MAX_AUTH_AGE_SEC = 24 * 60 * 60; // отклоняем устаревшие initData, чтобы ограничить повторное использование

// Строка проверки состоит из полей initData, кроме hash, отсортированных по имени и соединённых переводом строки. Подпись вычисляется по схеме Telegram Mini Apps:
// secretKey = HMAC_SHA256("WebAppData", botToken)
// hash = HMAC_SHA256(secretKey, dataCheckString)
// Схема проверена на подписанных данных Max.
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
    // Строка проверки и данные пользователя не записываются в журнал, поскольку содержат личную информацию.
    console.warn('[auth] initData hash mismatch');
    return { ok: false, reason: 'bad_hash' };
  }

  const authDate = Number(params.get('auth_date'));
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(nowSec - authDate) > MAX_AUTH_AGE_SEC) {
    return { ok: false, reason: 'expired' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (e) {
    // Ошибка игнорируется.
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
