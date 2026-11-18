/** Real model weather, never a measurement of pavement ice. No user location is transmitted. */
export interface WeatherSnapshot {
  temperatureC: number;
  precipitation24hMm: number | null;
  snowfall24hCm: number | null;
  weatherTime: string;
  retrievedAt: string;
  hourlySamples: number;
  periodStartedAt: string;
  periodEndedAt: string;
  source: 'Open-Meteo';
  retrievalMode: 'live' | 'captured';
}

export interface WeatherProvenance {
  url: string; retrievedAt: string; sha256: string; source: string;
  license: string; latitude: number; longitude: number;
}

export const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=37.4784&longitude=126.9516&current=temperature_2m&hourly=precipitation,snowfall&past_days=2&forecast_days=1&timeformat=unixtime&timezone=GMT';
const validNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseWeather(payload: unknown, now = Date.now()): WeatherSnapshot {
  if (!payload || typeof payload !== 'object') throw new Error('기상자료 형식을 확인할 수 없습니다.');
  const data = payload as Record<string, any>;
  const current = data.current;
  if (!current || !validNumber(current.temperature_2m) || !validNumber(current.time)) {
    throw new Error('기온 또는 기준 시각이 누락되었습니다.');
  }
  if (data.current_units?.temperature_2m !== '°C' || data.current_units?.time !== 'unixtime') {
    throw new Error('기상자료의 단위가 예상과 다릅니다.');
  }
  if (current.time * 1000 > now + 30 * 60_000 || now - current.time * 1000 > 2 * 60 * 60_000) {
    throw new Error('기상자료 기준 시각이 오래되었거나 올바르지 않습니다. 다시 조회해 주세요.');
  }
  const hourly = data.hourly;
  const times: unknown[] = Array.isArray(hourly?.time) ? hourly.time : [];
  // Hourly precipitation is the sum of the preceding hour. Exclude future samples.
  const end = Math.floor(current.time / 3600) * 3600;
  const indexes: number[] = [];
  for (let time = end - 23 * 3600; time <= end; time += 3600) {
    const matches = times.reduce<number[]>((all, value, index) => value === time ? [...all, index] : all, []);
    if (matches.length === 1) indexes.push(matches[0]);
  }
  function total(field: string, unit: string): number | null {
    if (indexes.length !== 24 || data.hourly_units?.[field] !== unit || !Array.isArray(hourly?.[field])) return null;
    const values = indexes.map(index => hourly[field][index]);
    if (!values.every((v: unknown) => validNumber(v) && v >= 0)) return null;
    return Math.round(values.reduce((a: number, b: number) => a + b, 0) * 100) / 100;
  }
  return {
    temperatureC: current.temperature_2m,
    precipitation24hMm: total('precipitation', 'mm'),
    snowfall24hCm: total('snowfall', 'cm'),
    weatherTime: new Date(current.time * 1000).toISOString(),
    retrievedAt: new Date(now).toISOString(),
    hourlySamples: indexes.length,
    periodStartedAt: new Date((end - 24 * 3600) * 1000).toISOString(),
    periodEndedAt: new Date(end * 1000).toISOString(),
    source: 'Open-Meteo',
    retrievalMode: 'live',
  };
}

/** Verify an actual captured response; its original acquisition time never changes. */
export async function parseCapturedWeather(raw: string, provenance: unknown, now = Date.now()): Promise<WeatherSnapshot> {
  if (!provenance || typeof provenance !== 'object') throw new Error('실제 기상 수집본의 출처 기록이 없습니다.');
  const recorded = provenance as Partial<WeatherProvenance>;
  const capturedAt = Date.parse(recorded.retrievedAt ?? '');
  if (recorded.url !== WEATHER_URL
    || recorded.source !== 'Open-Meteo weather model output; not a pavement observation'
    || recorded.license !== 'CC BY 4.0' || recorded.latitude !== 37.4784 || recorded.longitude !== 126.9516
    || typeof recorded.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(recorded.sha256)
    || !Number.isFinite(capturedAt) || capturedAt > now) {
    throw new Error('실제 기상 수집본의 출처·위치·수집 시각을 확인할 수 없습니다.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const actualHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (actualHash !== recorded.sha256.toLowerCase()) throw new Error('실제 기상 수집본과 출처 기록의 해시가 일치하지 않습니다.');
  const payload: unknown = JSON.parse(raw);
  // Validate both capture-time plausibility and current two-hour freshness.
  parseWeather(payload, capturedAt);
  const actual = parseWeather(payload, now);
  return { ...actual, retrievedAt: recorded.retrievedAt!, retrievalMode: 'captured' };
}

async function fetchLiveWeather(signal?: AbortSignal): Promise<WeatherSnapshot> {
  const timeout = AbortSignal.timeout(12_000);
  const response = await fetch(WEATHER_URL, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`기상자료를 불러오지 못했습니다 (${response.status}). 잠시 후 다시 시도해 주세요.`);
  const payload: unknown = await response.json();
  signal?.throwIfAborted();
  return parseWeather(payload);
}

async function fetchCapturedWeather(signal?: AbortSignal): Promise<WeatherSnapshot> {
  const timeout = AbortSignal.timeout(8_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const [response, metadata] = await Promise.all([
    fetch('/data/weather.json', { signal: requestSignal, cache: 'no-cache' }),
    fetch('/data/weather-provenance.json', { signal: requestSignal, cache: 'no-cache' }),
  ]);
  if (!response.ok || !metadata.ok) throw new Error('실제 기상 수집본 파일을 불러오지 못했습니다.');
  if (![response, metadata].every(item => item.headers.get('content-type')?.includes('application/json'))) {
    throw new Error('서버에 실제 기상 수집본 또는 출처 파일이 없습니다.');
  }
  const [raw, provenance] = await Promise.all([response.text(), metadata.json()]);
  const actual = await parseCapturedWeather(raw, provenance);
  requestSignal.throwIfAborted();
  return actual;
}

/** Live first. Only a verified, still-fresh real capture may follow a failure. */
export async function fetchWeather(signal?: AbortSignal): Promise<WeatherSnapshot> {
  signal?.throwIfAborted();
  try { return await fetchLiveWeather(signal); }
  catch (liveError) {
    if (signal?.aborted) throw signal.reason ?? liveError;
    try { return await fetchCapturedWeather(signal); }
    catch (capturedError) {
      if (signal?.aborted) throw signal.reason ?? capturedError;
      const detail = capturedError instanceof Error && !['TypeError', 'SyntaxError', 'TimeoutError'].includes(capturedError.name)
        ? capturedError.message : '유효한 실제 수집본을 확인할 수 없습니다.';
      throw new Error(`실시간 조회에 실패했고 사용할 수 있는 실제 수집본도 없습니다. ${detail}`);
    }
  }
}
