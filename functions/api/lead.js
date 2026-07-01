const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label, value) {
  const prepared = escapeHtml(value);
  return prepared ? `<b>${label}:</b> ${prepared}` : '';
}

function buildMessage(payload, request) {
  const source = clean(payload.source || 'main_form');
  const title = source === 'quiz' ? 'Новая заявка из квиза Talent Press' : 'Новая заявка Talent Press';
  const lines = [
    `<b>${title}</b>`,
    '',
    row('Имя', payload.name),
    row('Телефон / мессенджер', payload.phone),
    row('Telegram', payload.telegram),
    row('Сфера', payload.sphere),
    row('Портфолио', payload.portfolio),
    row('Источник формы', payload.quiz_source || payload.form_source || source),
    row('Опыт', payload.experience),
    row('Статус в США', payload.us_status),
    row('Чего не хватает', payload.missing_criteria),
    row('Бюджет', payload.budget),
    '',
    ...UTM_KEYS.map((key) => row(key, payload[key])).filter(Boolean),
    row('Страница', payload.page_url || request.headers.get('referer')),
    row('Время', payload.ts || new Date().toISOString()),
  ].filter(Boolean);

  return lines.join('\n');
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('Telegram is not configured');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Telegram error: ${response.status} ${details.slice(0, 200)}`);
  }
}

export async function onRequestPost({ request, env }) {
  let payload;

  try {
    payload = await request.json();
  } catch (error) {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const phone = clean(payload.phone);
  if (!phone || phone.length < 5) {
    return json({ ok: false, error: 'Phone is required' }, 400);
  }

  const text = buildMessage({ ...payload, phone }, request);

  try {
    await sendTelegram(env, text);
    return json({ ok: true });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: 'Telegram delivery failed' }, 500);
  }
}

export async function onRequestOptions() {
  return json({ ok: true });
}
