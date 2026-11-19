import replaySource from '../icing-replay-source.json';
import { distanceBetween } from '../core/network';

export const icingForecastUrl = 'https://api.open-meteo.com/v1/forecast?latitude=37.4784&longitude=126.9516&hourly=temperature_2m,precipitation,weather_code&past_days=1&forecast_days=2&timeformat=unixtime&timezone=GMT';
const hourSeconds = 3600;
export const icingWeatherMaxAgeMs = 30 * 60_000;
const weatherCenter: [number, number] = [126.9516, 37.4784];

export interface NearbyPrecipitation {
  station: string;
  time: number;
  mm: number;
  distanceM: number;
}

export interface IcingHour {
  time: number;
  temperatureC: number;
  precedingPrecipMm: number;
  weatherCode?: number;
  nearbyPrecipitation?: NearbyPrecipitation;
}

interface ForecastPayload {
  hourly_units?: { time?: string; temperature_2m?: string; precipitation?: string; weather_code?: string };
  hourly?: { time?: unknown[]; temperature_2m?: unknown[]; precipitation?: unknown[]; weather_code?: unknown[] };
}

export function findIcingHours(payload: unknown, nowMs: number): IcingHour[] {
  const { hourly_units: units, hourly } = (payload ?? {}) as ForecastPayload;
  if (units?.time !== 'unixtime' || units.temperature_2m !== '°C' || units.precipitation !== 'mm' ||
      !Array.isArray(hourly?.time) || !Array.isArray(hourly.temperature_2m) || !Array.isArray(hourly.precipitation)) {
    throw new Error('시간별 기온·강수 예보 확인에 실패했습니다.');
  }
  const first = Math.floor(nowMs / 1000 / hourSeconds) * hourSeconds;
  const indexes = new Map<number, number>();
  hourly.time.forEach((time, index) => {
    if (typeof time === 'number' && Number.isInteger(time) && time % hourSeconds === 0) {
      if (indexes.has(time)) throw new Error('시간별 예보에 중복된 시각이 있습니다.');
      indexes.set(time, index);
    }
  });
  const hours: IcingHour[] = [];
  for (let time = first; time <= first + 24 * hourSeconds; time += hourSeconds) {
    const index = indexes.get(time);
    if (index === undefined) continue;
    const temperatureC = hourly.temperature_2m[index];
    if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC)) continue;
    // Every precipitation row represents the preceding hour ending at its timestamp.
    const amounts: number[] = [];
    for (let ending = time - 5 * hourSeconds; ending <= time; ending += hourSeconds) {
      const rainIndex = indexes.get(ending);
      const amount = rainIndex === undefined ? undefined : hourly.precipitation[rainIndex];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) amounts.push(amount);
    }
    if (amounts.length !== 6) continue;
    const code = units.weather_code === 'wmo code' && Array.isArray(hourly.weather_code) ? hourly.weather_code[index] : undefined;
    hours.push({ time: time * 1000, temperatureC, precedingPrecipMm: amounts.reduce((a, b) => a + b, 0),
      ...(typeof code === 'number' && Number.isInteger(code) ? { weatherCode: code } : {}) });
  }
  if (!hours.length) throw new Error('최근 강수를 포함한 시간별 예보를 확인할 수 없습니다.');
  return hours;
}

export function hasRefreezeConditions(hour: IcingHour) {
  return hour.temperatureC <= 0 && (hour.precedingPrecipMm > 0 || (hour.nearbyPrecipitation?.mm ?? 0) > 0);
}

export function hasFreezingRain(hour: IcingHour) {
  return hour.weatherCode !== undefined && [56, 57, 66, 67].includes(hour.weatherCode);
}

export function readNearbyPrecipitation(payload: unknown, now: number): NearbyPrecipitation[] {
  const stations = (payload as { stations?: unknown } | null)?.stations;
  if (!Array.isArray(stations)) return [];
  const nearby: NearbyPrecipitation[] = [];
  for (const station of stations) {
    if (typeof station?.name !== 'string' || !station.name || !Number.isFinite(station.lat) || !Number.isFinite(station.lon) ||
        !Number.isFinite(station.rain60mMm) || station.rain60mMm < 0) continue;
    const time = Date.parse(station.observedAt);
    if (!Number.isFinite(time) || time > now || now - time >= icingWeatherMaxAgeMs) continue;
    const distanceM = distanceBetween(weatherCenter, [station.lon, station.lat]);
    if (distanceM <= 3000) nearby.push({ station: station.name, time, mm: station.rain60mMm, distanceM });
  }
  return nearby.sort((a, b) => a.distanceM - b.distanceM || b.time - a.time);
}

export function withNearbyPrecipitation(hour: IcingHour, observations: NearbyPrecipitation[], now: number): IcingHour {
  // The full observed one-hour total must fall inside the selected hour's six-hour lookback.
  const match = observations.find(record => record.mm > 0 && record.time <= now && now - record.time < icingWeatherMaxAgeMs
    && record.time <= hour.time && record.time >= hour.time - 5 * hourSeconds * 1000);
  return match ? { ...hour, nearbyPrecipitation: match } : hour;
}

export async function fetchNearbyPrecipitation(signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(14_000)]);
  const response = await fetch('/api/kma/weather', { signal: requestSignal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return [];
  const data: unknown = await response.json();
  requestSignal.throwIfAborted();
  return readNearbyPrecipitation(data, Date.now());
}

export async function fetchIcingHours(signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const response = await fetch(icingForecastUrl, { signal: requestSignal, cache: 'no-cache', redirect: 'error' });
  if (!response.ok) throw new Error('공개 예보를 불러오지 못했습니다.');
  const data: unknown = await response.json();
  requestSignal.throwIfAborted();
  const retrievedAt = Date.now();
  return { retrievedAt, hours: findIcingHours(data, retrievedAt) };
}
export async function readIcingReplay(raw: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== replaySource.sha256) throw new Error('과거 예보 원본의 해시가 일치하지 않습니다.');
  const time = Date.parse(replaySource.validAt);
  const hour = findIcingHours(JSON.parse(new TextDecoder().decode(raw)), time).find(item => item.time === time);
  if (!hour || !hasRefreezeConditions(hour)) throw new Error('시범 시각의 예보를 확인할 수 없습니다.');
  return hour;
}

export async function fetchIcingReplay(signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  const response = await fetch('/data/icing-replay.json', { signal: requestSignal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('과거 예보 파일을 불러오지 못했습니다.');
  }
  const hour = await readIcingReplay(await response.arrayBuffer());
  requestSignal.throwIfAborted();
  return hour;
}
