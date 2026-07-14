const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const AMO_TOKEN_KEY = 'oauth';
const AMO_FIELD_CACHE_TTL = 10 * 60 * 1000;
const amoFieldCache = new Map();

const LEAD_FIELD_MAP = [
  {
    key: 'sphere',
    aliases: ['по какой профессии', 'профессии или сфере', 'профессиональная сфера', 'сфера экспертизы', 'сфера'],
  },
  {
    key: 'experience',
    aliases: ['сколько у вас лет опыта', 'сколько у вас лет', 'опыт'],
  },
  {
    key: 'us_status',
    aliases: ['где вы сейчас находитесь', 'юридический статус', 'статус локация', 'статус в сша', 'в каком статусе'],
  },
  {
    key: 'missing_criteria',
    aliases: ['чего не хватает', 'не хватает для сильного', 'недостающие критерии', 'критерии'],
  },
  {
    key: 'service_format',
    aliases: ['формат услуг', 'какой формат услуг', 'какая услуга', 'услуга интересует', 'формат работы'],
  },
  {
    key: 'budget',
    aliases: ['бюджет', 'budget', 'во сколько', 'стоимость'],
  },
  {
    key: 'contact_messenger',
    aliases: ['messenger type', 'messenger-type', 'мессенджер', 'как с вами связаться', 'предпочтительный мессенджер'],
  },
  {
    key: 'telegram',
    aliases: ['telegram', 'ник в telegram', 'ваш ник', 'messenger id', 'messenger-id'],
  },
  {
    key: 'portfolio',
    aliases: ['портфолио', 'linkedin', 'instagram', 'сайт'],
  },
  {
    key: 'quiz_source',
    aliases: ['источник формы', 'источник заявки', 'form source', 'source'],
  },
  {
    key: 'page_url',
    aliases: ['страница', 'page url', 'page_url', 'url'],
  },
  ...UTM_KEYS.map((key) => ({
    key,
    aliases: [key, key.replace('_', ' ')],
  })),
];

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

function normalizeFieldText(value) {
  return cleanLong(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\p{L}\p{N}$]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function aliasMatches(haystack, alias) {
  const prepared = normalizeFieldText(alias);
  if (!prepared) {
    return false;
  }

  if (haystack.includes(prepared)) {
    return true;
  }

  const tokens = prepared.split(' ').filter((token) => token.length > 2);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function findAmoField(fields, aliases, usedFieldIds) {
  return fields.find((field) => {
    if (usedFieldIds.has(field.id)) {
      return false;
    }

    const haystack = normalizeFieldText([
      field.name,
      field.code,
      field.field_code,
    ].filter(Boolean).join(' '));

    return aliases.some((alias) => aliasMatches(haystack, alias));
  });
}

function buildAmoCustomFieldValue(field, rawValue) {
  const value = cleanLong(rawValue);
  if (!field || !value) {
    return null;
  }

  const type = String(field.type || '').toLowerCase();
  if (['select', 'radiobutton', 'multiselect'].includes(type)) {
    const chunks = value.split(/[;,]/).map(clean).filter(Boolean);
    const enums = Array.isArray(field.enums) ? field.enums : [];
    const values = chunks
      .map((chunk) => {
        const matched = enums.find((item) => aliasMatches(normalizeFieldText(item.value), chunk));
        return matched ? { value: matched.value, enum_id: matched.id } : null;
      })
      .filter(Boolean);

    return values.length ? { field_id: field.id, values } : null;
  }

  if (['numeric', 'monetary'].includes(type)) {
    const amount = parseAmoNumber(value);
    return Number.isFinite(amount) ? { field_id: field.id, values: [{ value: amount }] } : null;
  }

  return { field_id: field.id, values: [{ value }] };
}

function parseAmoNumber(value) {
  const prepared = clean(value).replace(/[^\d.,-]/g, '');
  if (!prepared) {
    return NaN;
  }

  const normalized = /,\d{3}(?:\D|$)/.test(prepared)
    ? prepared.replace(/,/g, '')
    : prepared.replace(',', '.');

  return Number(normalized);
}

function parseLeadPrice(payload) {
  const source = [
    payload.service_format,
    payload.budget,
  ].map(cleanLong).join(' ');

  if (source.includes('10,000') || source.includes('10000') || source.includes('10 000')) {
    return 10000;
  }

  if (source.includes('5,000') || source.includes('5000') || source.includes('5 000')) {
    return 5000;
  }

  if (source.includes('$100') || source.includes(' 100') || source.includes('- 100')) {
    return 100;
  }

  return 0;
}

function buildAmoTags(payload) {
  const tags = ['beauty-o-1.com'];
  const source = clean(payload.quiz_source || payload.form_source || payload.source);
  const service = cleanLong(payload.service_format).toLowerCase();

  if (source) {
    tags.push(source === 'quiz' ? 'quiz' : `source: ${source}`);
  }

  if (service.includes('под ключ')) {
    tags.push('O-1 под ключ');
  } else if (service.includes('частич')) {
    tags.push('частичное закрытие критериев');
  } else if (service.includes('разбор')) {
    tags.push('разбор кейса');
  }

  return [...new Set(tags)].map((name) => ({ name }));
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

async function getAmoCustomFields(env, entity) {
  const cacheKey = `${getAmoBaseUrl(env)}:${entity}`;
  const cached = amoFieldCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AMO_FIELD_CACHE_TTL) {
    return cached.fields;
  }

  const fields = [];
  let page = 1;

  while (page <= 10) {
    const data = await amoRequest(env, `/api/v4/${entity}/custom_fields?limit=250&page=${page}`, {
      method: 'GET',
    });

    const batch = data?._embedded?.custom_fields || [];
    fields.push(...batch);

    if (!data?._links?.next?.href || batch.length === 0) {
      break;
    }

    page += 1;
  }

  amoFieldCache.set(cacheKey, { ts: Date.now(), fields });
  return fields;
}

async function amoLeadFields(env, payload, request) {
  const fields = await getAmoCustomFields(env, 'leads');
  const usedFieldIds = new Set();
  const customFields = [];
  const price = parseLeadPrice(payload);
  const preparedPayload = {
    ...payload,
    budget: payload.budget || (price ? String(price) : ''),
    quiz_source: payload.quiz_source || payload.form_source || payload.source,
    page_url: payload.page_url || request.headers.get('referer'),
  };

  for (const item of LEAD_FIELD_MAP) {
    const value = preparedPayload[item.key];
    if (!cleanLong(value)) {
      continue;
    }

    const field = findAmoField(fields, item.aliases, usedFieldIds);
    const customField = buildAmoCustomFieldValue(field, value);
    if (customField) {
      usedFieldIds.add(field.id);
      customFields.push(customField);
    }
  }

  return customFields;
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
  let leadFields = [];
  try {
    leadFields = await amoLeadFields(env, payload, request);
  } catch (error) {
    console.error('amoCRM field mapping skipped', error);
  }
  const price = parseLeadPrice(payload);
  const complexLead = [{
    name: leadTitle,
    ...(price ? { price } : {}),
    ...(leadFields.length ? { custom_fields_values: leadFields } : {}),
    _embedded: {
      tags: buildAmoTags(payload),
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
