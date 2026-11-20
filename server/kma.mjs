// Worker-compatible server module: credentials are sent only to the fixed HTTPS KMA host.
// No Node filesystem, credential URL, provider error body or made-up weather enters the response.
import capturedSource from '../public/data/kma-source.json' with { type: 'json' };
import { KMA_PUBLIC_REQUEST, KmaDataError, kmaAwsMinute, kmaAwsQueryMinute, parseKmaAws, parseKmaCapture, parseKmaHourlyRain, sha256Hex } from './kma-parser.mjs';

let cached = null;
let inFlight = null;
const CACHE_MS = 60000;
const hourMs = 3_600_000;
const hourlyRain = new Map();
const pendingHours = new Map();

async function fetchAwsRows(key, minute, timeout) {
  const url = new URL(KMA_PUBLIC_REQUEST);
  url.searchParams.set('tm2', minute);
  url.searchParams.set('authKey', key);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout), headers: { Accept: 'text/plain' } });
  if (response.status >= 300 && response.status < 400) throw new KmaDataError('unexpected-redirect');
  if (!response.ok) throw new KmaDataError(response.status === 401 || response.status === 403 ? 'service-authorization' : 'upstream-http-error');
  if (Number(response.headers.get('content-length')) > 2000000) throw new KmaDataError('response-too-large');
  const raw = await response.text();
  if (raw.length > 2000000 || raw.includes(key)) throw new KmaDataError('invalid-response');
  return raw;
}

async function acquire(env) {
  const key = typeof env?.KMA_API_KEY === 'string' ? env.KMA_API_KEY.trim() : '';
  let failureCode = 'missing-server-key';
  if (key) {
    try {
      const raw = await fetchAwsRows(key, kmaAwsQueryMinute(), 18000);
      const retrievedAt = new Date().toISOString();
      const parsed = parseKmaAws(raw, { retrievedAt, retrievalMode: 'live', sha256: await sha256Hex(raw) });
      cached = { value: parsed, at: Date.now() };
      return parsed;
    } catch (error) {
      // Fetch errors may contain credential-bearing URLs in their cause; never expose them.
      failureCode = error instanceof KmaDataError ? error.code : error?.name === 'TimeoutError' ? 'upstream-timeout' : 'upstream-unavailable';
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

function getRainForHour(time, key, now) {
  const entry = hourlyRain.get(time);
  if (entry && entry.retryAt > now) return entry.rows;
  if (!pendingHours.has(time)) {
    pendingHours.set(time, fetchAwsRows(key, kmaAwsMinute(time), 6500)
      .then(raw => parseKmaHourlyRain(raw, time)).catch(() => null)
      .then(rows => {
        hourlyRain.set(time, { rows, retryAt: rows ? Infinity : Date.now() + 5 * CACHE_MS });
        return rows;
      }).finally(() => pendingHours.delete(time)));
  }
  return pendingHours.get(time);
}

export async function getKmaRainHistory(env, now = Date.now()) {
  const key = typeof env?.KMA_API_KEY === 'string' ? env.KMA_API_KEY.trim() : '';
  if (!key) throw new KmaDataError('missing-server-key');
  const latest = Math.floor((now - 5 * CACHE_MS) / hourMs) * hourMs;
  // Each row is a 1-hour total ending at the hour. Keep only whole windows in the lookback.
  const hours = Array.from({ length: 12 }, (_, index) => latest - index * hourMs)
    .filter(time => time >= now - 11 * hourMs);
  for (const time of hourlyRain.keys()) if (time < now - 12 * hourMs) hourlyRain.delete(time);

  const stations = [];
  let receivedHours = 0;
  for (let i = 0; i < hours.length; i += 4) {
    const batch = await Promise.all(hours.slice(i, i + 4).map(time => getRainForHour(time, key, now)));
    for (const rows of batch) {
      if (!rows) continue;
      receivedHours++;
      stations.push(...rows);
    }
  }
  if (!receivedHours) throw new KmaDataError('no-hourly-rain');
  return { stations, receivedHours, requestedHours: hours.length };
}
