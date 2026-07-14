const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const AMO_TOKEN_KEY = 'oauth';

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

function cleanLong(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
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
    row('Формат услуг', payload.service_format),
    row('Бюджет', payload.budget),
    row('Предпочтительный мессенджер', payload.contact_messenger),
    '',
    ...UTM_KEYS.map((key) => row(key, payload[key])).filter(Boolean),
    row('Страница', payload.page_url || request.headers.get('referer')),
    row('Время', payload.ts || new Date().toISOString()),
  ].filter(Boolean);

  return lines.join('\n');
}

function plainRow(label, value) {
  const prepared = cleanLong(value);
  return prepared ? `${label}: ${prepared}` : '';
}

function buildPlainLeadText(payload, request) {
  const source = clean(payload.source || 'main_form');
  return [
    'Заявка с сайта beauty-o-1.com',
    '',
    plainRow('Имя', payload.name),
    plainRow('Телефон / мессенджер', payload.phone),
    plainRow('Telegram', payload.telegram),
    plainRow('Сфера', payload.sphere),
    plainRow('Портфолио', payload.portfolio),
    plainRow('Источник формы', payload.quiz_source || payload.form_source || source),
    plainRow('Опыт', payload.experience),
    plainRow('Статус в США', payload.us_status),
    plainRow('Чего не хватает', payload.missing_criteria),
    plainRow('Формат услуг', payload.service_format),
    plainRow('Бюджет', payload.budget),
    plainRow('Предпочтительный мессенджер', payload.contact_messenger),
    '',
    ...UTM_KEYS.map((key) => plainRow(key, payload[key])).filter(Boolean),
    plainRow('Страница', payload.page_url || request.headers.get('referer')),
    plainRow('Время', payload.ts || new Date().toISOString()),
  ].filter(Boolean).join('\n');
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

function getAmoBaseUrl(env) {
  const subdomain = clean(env.AMO_SUBDOMAIN).replace(/^https?:\/\//, '').replace(/\.amocrm\.(ru|com).*$/, '');
  return subdomain ? `https://${subdomain}.amocrm.ru` : '';
}

async function readAmoToken(env) {
  if (env.AMO_ACCESS_TOKEN) {
    return { access_token: env.AMO_ACCESS_TOKEN };
  }

  if (!env.AMO_TOKENS?.get) {
    return null;
  }

  const raw = await env.AMO_TOKENS.get(AMO_TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function writeAmoToken(env, token) {
  if (!env.AMO_TOKENS?.put) {
    return;
  }

  const expiresIn = Number(token.expires_in || 86400);
  await env.AMO_TOKENS.put(AMO_TOKEN_KEY, JSON.stringify({
    ...token,
    expires_at: Date.now() + expiresIn * 1000 - 60 * 1000,
  }));
}

async function refreshAmoToken(env, token) {
  const baseUrl = getAmoBaseUrl(env);
  if (!baseUrl || !env.AMO_CLIENT_ID || !env.AMO_CLIENT_SECRET || !env.AMO_REDIRECT_URI || !token?.refresh_token) {
    throw new Error('amoCRM OAuth is not configured');
  }

  const response = await fetch(`${baseUrl}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.AMO_CLIENT_ID,
      client_secret: env.AMO_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
      redirect_uri: env.AMO_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`amoCRM token refresh error: ${response.status} ${details.slice(0, 200)}`);
  }

  const nextToken = await response.json();
  await writeAmoToken(env, nextToken);
  return nextToken;
}

async function getAmoAccessToken(env) {
  const token = await readAmoToken(env);
  if (!token?.access_token) {
    return '';
  }

  if (token.expires_at && Date.now() > Number(token.expires_at)) {
    const refreshed = await refreshAmoToken(env, token);
    return refreshed.access_token;
  }

  return token.access_token;
}

async function amoRequest(env, path, options = {}) {
  const baseUrl = getAmoBaseUrl(env);
  const accessToken = await getAmoAccessToken(env);
  if (!baseUrl || !accessToken) {
    return null;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`amoCRM error: ${response.status} ${details.slice(0, 300)}`);
  }

  return response.status === 204 ? null : response.json();
}

function amoContactFields(payload) {
  const fields = [];
  const phone = clean(payload.phone);
  const email = clean(payload.email);

  if (phone) {
    fields.push({
      field_code: 'PHONE',
      values: [{ value: phone, enum_code: 'WORK' }],
    });
  }

  if (email) {
    fields.push({
      field_code: 'EMAIL',
      values: [{ value: email, enum_code: 'WORK' }],
    });
  }

  return fields;
}

async function sendAmoCrm(env, payload, request) {
  if (!getAmoBaseUrl(env)) {
    return { skipped: true };
  }

  const name = clean(payload.name) || clean(payload.telegram) || clean(payload.phone) || 'Лид с сайта';
  const source = clean(payload.source || 'main_form');
  const leadTitle = source === 'quiz' ? `Квиз O-1 Beauty - ${name}` : `Заявка O-1 Beauty - ${name}`;
  const complexLead = [{
    name: leadTitle,
    _embedded: {
      tags: [{ name: 'beauty-o-1.com' }],
      contacts: [{
        name,
        custom_fields_values: amoContactFields(payload),
      }],
    },
  }];

  const created = await amoRequest(env, '/api/v4/leads/complex', {
    method: 'POST',
    body: JSON.stringify(complexLead),
  });

  const leadId = created?.[0]?.id || created?._embedded?.leads?.[0]?.id;
  if (leadId) {
    await amoRequest(env, `/api/v4/leads/${leadId}/notes`, {
      method: 'POST',
      body: JSON.stringify([{
        note_type: 'common',
        params: {
          text: buildPlainLeadText(payload, request),
        },
      }]),
    });
  }

  return { skipped: false, leadId };
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

  const delivery = await Promise.allSettled([
    sendTelegram(env, text),
    sendAmoCrm(env, { ...payload, phone }, request),
  ]);

  const telegram = delivery[0];
  const amo = delivery[1];

  if (telegram.status === 'rejected') {
    console.error(telegram.reason);
  }

  if (amo.status === 'rejected') {
    console.error(amo.reason);
  }

  const telegramDelivered = telegram.status === 'fulfilled';
  const amoDelivered = amo.status === 'fulfilled' && !amo.value?.skipped;

  if (telegramDelivered || amoDelivered) {
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Lead delivery failed' }, 500);
}

export async function onRequestOptions() {
  return json({ ok: true });
}
