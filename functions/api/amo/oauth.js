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
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 3000);
}

function getAmoBaseUrl(env) {
  const subdomain = clean(env.AMO_SUBDOMAIN).replace(/^https?:\/\//, '').replace(/\.amocrm\.(ru|com).*$/, '');
  return subdomain ? `https://${subdomain}.amocrm.ru` : '';
}

async function writeAmoToken(env, token) {
  const expiresIn = Number(token.expires_in || 86400);
  await env.AMO_TOKENS.put(AMO_TOKEN_KEY, JSON.stringify({
    ...token,
    expires_at: Date.now() + expiresIn * 1000 - 60 * 1000,
  }));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = clean(url.searchParams.get('code'));

  if (!code) {
    return json({ ok: false, error: 'Authorization code is required' }, 400);
  }

  const baseUrl = getAmoBaseUrl(env);
  if (!baseUrl || !env.AMO_CLIENT_ID || !env.AMO_CLIENT_SECRET || !env.AMO_REDIRECT_URI || !env.AMO_TOKENS?.put) {
    return json({ ok: false, error: 'amoCRM OAuth is not configured' }, 500);
  }

  const response = await fetch(`${baseUrl}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.AMO_CLIENT_ID,
      client_secret: env.AMO_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.AMO_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    return json({ ok: false, error: `amoCRM OAuth failed: ${details.slice(0, 300)}` }, 502);
  }

  await writeAmoToken(env, await response.json());
  return json({ ok: true, message: 'amoCRM connected' });
}
