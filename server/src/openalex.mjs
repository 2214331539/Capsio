// OpenAlex for the app's paper search and recommendations, with the service's API key.
// OpenAlex gives keyless requests a daily budget per network address, which everyone behind
// one address (a campus, say) shares. Signed-in users only, a bounded rate each, and only the
// read-only works endpoints; the key never leaves the server.

import { fail } from './http.mjs';

const UPSTREAM = 'https://api.openalex.org';
/** `/v1/openalex/works`, `/v1/openalex/works/W123`, `/v1/openalex/works/https://doi.org/…` */
const PATH = /^\/v1\/openalex\/(works(?:\/[A-Za-z0-9:._%/-]+)?)$/;
const PER_MINUTE = 60;
const TIMEOUT_MS = 30_000;

const recent = new Map();

function limit(userId, now = Date.now()) {
  const times = (recent.get(userId) ?? []).filter((at) => now - at < 60_000);
  if (times.length >= PER_MINUTE) throw fail(429, 'OpenAlex 请求太频繁，请稍后再试。', 'rate_limited');
  times.push(now);
  recent.set(userId, times);
  if (recent.size > 20_000) {
    for (const [key, list] of recent) if (list.every((at) => now - at >= 60_000)) recent.delete(key);
  }
}

/** The OpenAlex address a request stands for, with the key, or null when it is not one. */
export function upstreamUrl(path, search, apiKey) {
  const match = path.match(PATH);
  if (!match || match[1].includes('..')) return null;
  const target = new URL(`${UPSTREAM}/${match[1]}`);
  for (const [key, value] of search) if (key !== 'api_key') target.searchParams.append(key, value);
  target.searchParams.set('api_key', apiKey);
  return target;
}

/** Answers `GET /v1/openalex/works…` for a signed-in user; false for any other request. */
export async function handleOpenAlex(request, response, context, path, url, user) {
  if (request.method !== 'GET' || !path.startsWith('/v1/openalex/')) return false;
  const apiKey = context.config.openalex?.apiKey;
  if (!apiKey) throw fail(503, 'OpenAlex 转发未配置。');
  const target = upstreamUrl(path, url.searchParams, apiKey);
  if (!target) throw fail(404, '不支持的 OpenAlex 地址。');
  limit(user.sub);
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { 'user-agent': 'Capsio (https://capsio.cloud)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw fail(502, 'OpenAlex 暂时连不上。');
  }
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
  return true;
}
