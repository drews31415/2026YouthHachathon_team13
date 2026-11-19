// Worker-compatible server module: credentials are sent only to the fixed HTTPS KMA host.
// No Node filesystem, credential URL, provider error body or made-up weather enters the response.
import capturedSource from '../public/data/kma-source.json' with { type: 'json' };
import { KMA_PUBLIC_REQUEST, KmaDataError, parseKmaAws, parseKmaCapture, sha256Hex } from './kma-parser.mjs';

let cached = null;
let inFlight = null;
const CACHE_MS = 60000;

async function acquire(env) {
  const key = typeof env?.KMA_API_KEY === 'string' ? env.KMA_API_KEY.trim() : '';
  let failureCode = 'missing-server-key';
  if (key) {
    try {
      const url = new URL(KMA_PUBLIC_REQUEST);
      url.searchParams.set('authKey', key);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Accept: 'text/plain' } });
      if (!response.ok) throw new KmaDataError(response.status === 401 || response.status === 403 ? 'service-authorization' : 'upstream-http-error');
      if (Number(response.headers.get('content-length')) > 2000000) throw new KmaDataError('response-too-large');
      const raw = await response.text();
      if (raw.length > 2000000 || raw.includes(key)) throw new KmaDataError('invalid-response');
      const retrievedAt = new Date().toISOString();
      const parsed = parseKmaAws(raw, { retrievedAt, retrievalMode: 'live', sha256: await sha256Hex(raw) });
      cached = { value: parsed, at: Date.now() };
      return parsed;
    } catch (error) {
      // Fetch errors may contain credential-bearing URLs in their cause; never expose them.
      failureCode = error instanceof KmaDataError ? error.code : 'upstream-unavailable';
    }
  }
  try {
    const parsed = await parseKmaCapture(capturedSource);
    return { ...parsed, fallbackReason: failureCode };
  } catch {
    throw new KmaDataError(`${failureCode};no-fresh-captured-observations`);
  }
}

/** Actual observations, or a hash-verified real capture still within the 30-minute observation window. */
export async function getKmaWeather(env = globalThis.process?.env ?? {}) {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS && Date.parse(cached.value.expiresAt) > now) return cached.value;
  if (!inFlight) inFlight = acquire(env).finally(() => { inFlight = null; });
  return inFlight;
}
