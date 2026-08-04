const { BOT_TOKEN } = require('./env');

const API_BASE = 'https://platform-api2.max.ru';

async function sendMessage(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  const url = `${API_BASE}/messages?chat_id=${encodeURIComponent(chatId)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: BOT_TOKEN,
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[bot] sendMessage failed', res.status, body);
    }
  } catch (e) {
    console.error('[bot] sendMessage error', e.message);
  }
}

module.exports = { sendMessage };
