import { deliverSiteLead } from './lead.js';

const liveOrigins = new Set(['https://talent-press.com', 'https://www.talent-press.com']);
const previewOrigin = 'https://anisimovkat-hub.github.io';
const maxBodyBytes = 16 * 1024;
const additionalAnswers = {
  city: 'Город',
  track: 'Категория',
  pr: 'PR',
  profession: 'Профессия',
};

const clean = (value, limit = 120) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
  : '';

function reply(status, data, origin) {
  return new Response(data ? JSON.stringify(data) : null, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Origin',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    },
  });
}

async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Empty request');
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return JSON.parse(body + decoder.decode());
    size += value.byteLength;
    if (size > maxBodyBytes) {
      await reader.cancel();
      throw new Error('Request is too large');
    }
    body += decoder.decode(value, { stream: true });
  }
}

function toLead(input, origin) {
  const requestId = clean(input?.requestId, 40);
  const phone = clean(input?.phone, 60);
  const telegram = clean(input?.tg, 34);
  const consentVersion = clean(input?.consentVersion, 30);
  if (
    !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(requestId) ||
    !/^[+()\d\s.-]{6,60}$/.test(phone) || phone.replace(/\D/g, '').length < 6 ||
    !/^@[A-Za-z0-9_]{5,32}$/.test(telegram) ||
    input.consent !== true || !consentVersion || input.website ||
    !['us', 'uk', 'fr', 'any'].includes(input.flow)
  ) throw new Error('Invalid lead');

  const page = new URL(clean(input.page, 1000));
  if (page.origin !== origin || (origin === previewOrigin && !page.pathname.startsWith('/talent-press-preview/'))) {
    throw new Error('Invalid page');
  }
  const fields = {
    name: clean(input.name),
    phone,
    telegram,
    sphere: clean(input.field),
    experience: clean(input.exp),
    us_status: clean(input.status),
    missing_criteria: clean(input.gap, 240),
    budget: clean(input.budget),
    page_url: page.origin + page.pathname,
    quiz_source: 'talent-press.com',
  };
  const utm = Object.fromEntries(['source', 'medium', 'campaign', 'content', 'term']
    .map(key => ['utm_' + key, clean(input.utm?.['utm_' + key] || page.searchParams.get('utm_' + key), 160)]));
  const details = [
    ['ID заявки', requestId],
    ['Версия согласия', consentVersion],
    ['Страна', clean(input.country) || input.flow],
    ['Язык', input.lang === 'en' ? 'en' : 'ru'],
    ['Удобное время', clean(input.time)],
    ...Object.entries(additionalAnswers).map(([key, label]) => [label, clean(input[key])]),
    ['yclid', clean(page.searchParams.get('yclid'), 80)],
  ];
  const site_details = details.filter(([, value]) => value).map(([label, value]) => label + ' ' + value).join(' · ');
  return { ...fields, ...utm, site_details };
}

export async function onRequest({ request, env }) {
  const origin = request.headers.get('Origin');
  const allowed = liveOrigins.has(origin) || (env.SITE_LEADS_PREVIEW === 'true' && origin === previewOrigin);
  if (!allowed) return reply(403, { ok: false });
  if (request.method === 'OPTIONS') {
    const response = reply(204, null, origin);
    response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type');
    return response;
  }
  if (request.method !== 'POST') return reply(405, { ok: false }, origin);
  if (env.SITE_LEADS_ENABLED !== 'true') return reply(503, { ok: false }, origin);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) {
    return reply(415, { ok: false }, origin);
  }
  let lead;
  try {
    lead = toLead(await readPayload(request), origin);
  } catch {
    return reply(400, { ok: false }, origin);
  }
  try {
    const delivery = await deliverSiteLead(env, lead, request);
    return reply(200, { ok: true, telegram: delivery.telegram }, origin);
  } catch {
    console.error('Talent Press: amoCRM did not accept the lead');
    return reply(502, { ok: false }, origin);
  }
}
