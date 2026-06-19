// Cloudflare Pages Function — proxies JobQuest's AI calls to the Anthropic API.
//
// The browser POSTs an Anthropic Messages-API body to /api/claude (same origin,
// no CORS). This function adds the secret key server-side and forwards the call,
// streaming the response straight back. Your Anthropic key therefore never
// touches the browser.
//
// REQUIRED: set ANTHROPIC_API_KEY in your Cloudflare Pages project
//   Settings → Environment variables → add ANTHROPIC_API_KEY (your sk-ant-… key)
//
// Path convention: this file lives at  functions/api/claude.js  →  /api/claude

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export async function onRequestPost(context) {
  const { request, env } = context;

  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: { message: 'ANTHROPIC_API_KEY is not set in this Cloudflare Pages deployment\u2019s environment variables.' } }, 500);
  }

  let body;
  try {
    body = await request.text(); // pass the body through unchanged
  } catch (e) {
    return json({ error: { message: 'Could not read request body.' } }, 400);
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  // The web_search tool ships behind a beta flag on some accounts; harmless if unused.
  if (body.includes('web_search')) headers['anthropic-beta'] = 'web-search-2025-03-05';

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body });
  } catch (e) {
    return json({ error: { message: 'Upstream request to Anthropic failed: ' + e.message } }, 502);
  }

  // Stream the response back verbatim (works for both SSE streaming and plain JSON),
  // preserving status and content type so the client can parse either.
  const respHeaders = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) respHeaders.set('content-type', ct);
  respHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}

// Friendly response for anything that isn't a POST (e.g. opening the URL directly).
export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return json({ ok: true, message: 'JobQuest Claude proxy is live. POST Anthropic Messages-API requests here.' }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
  });
}
