import replaySource from '../icing-replay-source.json';
import snowReplaySource from '../icing-snow-replay-source.json';
import gangnamReplaySource from '../icing-gangnam-replay-source.json';
import gangnamGridReplay from '../icing-gangnam-grid-replay.json';
import icingRegions from '../../icing-regions.json';
import { distanceBetween } from '../core/network';
import type { Coordinate } from '../core/types';

export const icingForecastUrl = 'https://api.open-meteo.com/v1/forecast?latitude=37.4784&longitude=126.9516&hourly=temperature_2m,precipitation,weather_code,snow_depth,snowfall,dew_point_2m,wind_speed_10m,shortwave_radiation,soil_temperature_0cm&past_days=1&forecast_days=2&timeformat=unixtime&timezone=GMT';
const hourSeconds = 3600;
const hourMs = 3600_000;
const tenMinutesMs = 10 * 60_000;
export const icingWeatherMaxAgeMs = 30 * 60_000;
export const icingRainHistoryMs = 12 * hourMs;
export type IcingArea = keyof typeof icingRegions;
export const icingReplays = {
  original: { ...replaySource, path: '/data/icing-replay.json' },
  snow: { ...snowReplaySource, path: '/data/icing-snow-replay.json' },
  gangnam: { ...gangnamReplaySource, path: '/data/gangnam/icing-replay.json' },
};
export type IcingReplay = keyof typeof icingReplays;

export interface KmaGridRow {
  time: number;
  temperatureC: number | null;
  dewPointC: number | null;
  humidity: number | null;
  windMps: number | null;
  rain60mMm: number | null;
  snowDepthCm: number | null;
  newSnow3hCm: number | null;
}
type GridWeather = { status: 'ok'; rows: KmaGridRow[] } | { status: 'unavailable' | 'permission' };

export interface NearbyPrecipitation {
  station: string;
  time: number;
  mm: number;
  distanceM: number;
  durationMs?: number;
}

export interface IcingHour {
  time: number;
  temperatureC: number;
  soilTemperatureC?: number;
  precedingPrecipMm: number | null;
  recentPrecipitation?: boolean;
  weatherCode?: number;
  nearbyPrecipitation?: NearbyPrecipitation;
  kma?: KmaForecastHour;
  snowDepthM?: number;
  snowfallCm?: number;
  dewPointC?: number;
  windKmh?: number;
  solarWm2?: number;
  recentSnowfall?: boolean;
  recentThawOnSnow?: boolean;
  coldAfterMoisture?: boolean;
  coldHistoryStart?: number;
  grid?: KmaGridRow;
  gridMoisture?: boolean;
}

interface KmaForecastHour {
  time: number;
  issuedAt: number;
  kind: 'ultra' | 'short';
  temperatureC: number;
  precipitation: string | null;
  wet: boolean;
  humidity: number | null;
}
interface KmaForecast { retrievedAt: number; ultra: KmaForecastHour[]; short: KmaForecastHour[] }

interface ForecastPayload {
  hourly_units?: Record<string, string>;
  hourly?: Record<string, unknown[]>;
}

export function findIcingHours(payload: unknown, nowMs: number): IcingHour[] {
  const { hourly_units: units, hourly } = (payload ?? {}) as ForecastPayload;
  if (units?.time !== 'unixtime' || units.temperature_2m !== '°C' ||
      !Array.isArray(hourly?.time) || !Array.isArray(hourly.temperature_2m)) {
    throw new Error('시간별 기온 예보 확인에 실패했습니다.');
  }
  const first = Math.floor(nowMs / 1000 / hourSeconds) * hourSeconds;
  const indexes = new Map<number, number>();
  hourly.time.forEach((time, index) => {
    if (typeof time === 'number' && Number.isInteger(time) && time % hourSeconds === 0) {
      if (indexes.has(time)) throw new Error('시간별 예보에 중복된 시각이 있습니다.');
      indexes.set(time, index);
    }
  });
  const read = (name: string, unit: string, index: number | undefined, min = 0) => {
    if (index === undefined || units[name] !== unit || !Array.isArray(hourly[name])) return undefined;
    const value = hourly[name][index];
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : undefined;
  };
  const hours: IcingHour[] = [];
  for (let time = first; time <= first + 24 * hourSeconds; time += hourSeconds) {
    const index = indexes.get(time);
    if (index === undefined) continue;
    const temperatureC = hourly.temperature_2m[index];
    if (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC)) continue;
    // Every precipitation row represents the preceding hour ending at its timestamp.
    const amounts: number[] = [];
    for (let ending = time - 5 * hourSeconds; ending <= time; ending += hourSeconds) {
      const amount = read('precipitation', 'mm', indexes.get(ending));
      if (amount !== undefined) amounts.push(amount);
    }
    const code = units.weather_code === 'wmo code' && Array.isArray(hourly.weather_code) ? hourly.weather_code[index] : undefined;
    const forecast: IcingHour = { time: time * 1000, temperatureC,
      precedingPrecipMm: amounts.length === 6 ? amounts.reduce((a, b) => a + b, 0) : null };
    if (forecast.precedingPrecipMm === null && amounts.some(amount => amount > 0)) forecast.recentPrecipitation = true;
    if (typeof code === 'number' && Number.isInteger(code)) forecast.weatherCode = code;
    forecast.snowDepthM = read('snow_depth', 'm', index);
    forecast.snowfallCm = read('snowfall', 'cm', index);
    forecast.dewPointC = read('dew_point_2m', '°C', index, -100);
    forecast.windKmh = read('wind_speed_10m', 'km/h', index);
    forecast.solarWm2 = read('shortwave_radiation', 'W/m²', index);
    const soilTemperatureC = read('soil_temperature_0cm', '°C', index, -100);
    if (soilTemperatureC !== undefined) forecast.soilTemperatureC = soilTemperatureC;
    let stayedBelowFreezing = true;
    for (let offset = 0; offset <= 12; offset++) {
      const past = indexes.get(time - offset * hourSeconds);
      const snowfall = (read('snowfall', 'cm', past) ?? 0) > 0;
      if (offset < 6 && snowfall) forecast.recentSnowfall = true;
      if (offset === 0) continue;

      const pastTemperature = read('temperature_2m', '°C', past, -100);
      const thawOnSnow = (pastTemperature ?? 0) > 0 && (read('snow_depth', 'm', past) ?? 0) > 0;
      if (thawOnSnow) forecast.recentThawOnSnow = true;
      // A precipitation row covers the full preceding hour, so its end must be less than 12 hours old.
      const fellRecently = offset < 12 && (snowfall || (read('precipitation', 'mm', past) ?? 0) > 0);
      if (stayedBelowFreezing) {
        forecast.coldHistoryStart = (time - offset * hourSeconds) * 1000;
        if (fellRecently || thawOnSnow) forecast.coldAfterMoisture = true;
      }
      stayedBelowFreezing &&= pastTemperature !== undefined && pastTemperature <= 0;
    }
    // Keep archived records with omitted variables unchanged.
    for (const key of ['snowDepthM', 'snowfallCm', 'dewPointC', 'windKmh', 'solarWm2'] as const) {
      if (forecast[key] === undefined) delete forecast[key];
    }
    hours.push(forecast);
  }
  if (!hours.length) throw new Error('시간별 기온 예보를 확인할 수 없습니다.');
  return hours;
}

export function hasRefreezeConditions(hour: IcingHour) {
  return forecastTemperature(hour) <= 0 && hasMoistureEvidence(hour);
}

function hasMoistureEvidence(hour: IcingHour) {
  return (hour.precedingPrecipMm ?? 0) > 0 || hour.recentPrecipitation === true || hour.kma?.wet === true ||
    (hour.nearbyPrecipitation?.mm ?? 0) > 0 || hour.recentSnowfall === true || hour.gridMoisture === true ||
    hour.recentThawOnSnow === true;
}

export function hasSnowmeltRefreeze(hour: IcingHour) {
  return forecastTemperature(hour) <= 0 && hour.recentThawOnSnow === true;
}

export function hasHeatingWeather(hour: IcingHour) {
  if (forecastTemperature(hour) > 0 || hasFreezingRain(hour)) return false;
  const weatherCode = hour.weatherCode;
  const grid = hour.grid;
  const gridSnow = grid && (grid.newSnow3hCm ?? 0) > 0 && hour.time >= grid.time && hour.time - grid.time <= 3 * hourMs;
  return hour.recentSnowfall === true || (hour.snowfallCm ?? 0) > 0 ||
    (weatherCode !== undefined && [71, 73, 75, 77, 85, 86].includes(weatherCode)) || !!gridSnow;
}

export function hasFrostConditions(hour: IcingHour) {
  if (hour.dewPointC === undefined || hour.windKmh === undefined || hour.solarWm2 === undefined) return false;
  const gap = hour.temperatureC - hour.dewPointC;
  return forecastTemperature(hour) <= 0 && hour.temperatureC <= 0 && gap >= 0 && gap <= 2 &&
    hour.windKmh <= 10 && hour.solarWm2 < 5;
}

export function usesGridTemperature(hour: IcingHour) {
  return hour.grid?.time === hour.time && hour.grid.temperatureC !== null;
}

export function forecastTemperature(hour: IcingHour) {
  return (usesGridTemperature(hour) ? hour.grid?.temperatureC : null) ?? hour.kma?.temperatureC ?? hour.temperatureC;
}

function observationReferenceTime(hour: IcingHour, now: number) {
  return Math.floor(now / hourMs) * hourMs === hour.time ? now : hour.time;
}

export function withKmaGrid(hour: IcingHour, rows: KmaGridRow[], now: number): IcingHour {
  const referenceTime = observationReferenceTime(hour, now);
  const candidates = rows.filter(row => row.time <= Math.min(now, referenceTime) && row.time >= now - 90 * 60_000);
  const grid = candidates.filter(row => row.time <= hour.time).at(-1);
  const gridMoisture = candidates.some(row => {
    const age = referenceTime - row.time;
    return ((row.rain60mMm ?? 0) > 0 && age <= 5 * hourMs) ||
      ((row.newSnow3hCm ?? 0) > 0 && age <= 3 * hourMs) ||
      ((row.snowDepthCm ?? 0) > 0 && age <= 2 * hourMs);
  });
  return grid || gridMoisture ? { ...hour, grid, gridMoisture } : hour;
}

export function combineLiveForecast(hours: IcingHour[], kma: KmaForecast | undefined, now: number): IcingHour[] {
  const hourMs = hourSeconds * 1000;
  const first = Math.floor(now / hourMs) * hourMs;
  const inRange = (time: number) => time >= first && time <= first + 24 * hourMs;
  const combined = new Map(hours.filter(hour => inRange(hour.time)).map(hour => [hour.time, hour]));
  if (kma && now - kma.retrievedAt < icingWeatherMaxAgeMs) {
    // Short-range fills gaps, with the more recent ultra-short product taking precedence.
    for (const row of [...kma.short, ...kma.ultra]) {
      if (!inRange(row.time) || row.issuedAt > now || now - row.issuedAt > (row.kind === 'ultra' ? 3 : 7) * hourMs) continue;
      const prior = combined.get(row.time);
      combined.set(row.time, prior ? { ...prior, kma: row } : {
        time: row.time, temperatureC: row.temperatureC, precedingPrecipMm: null, kma: row,
      });
    }
  }
  return [...combined.values()].sort((a, b) => a.time - b.time);
}

function weatherQuery(area: IcingArea | Coordinate) {
  return typeof area === 'string' ? new URLSearchParams({ area }) : new URLSearchParams({ lon: String(area[0]), lat: String(area[1]) });
}

export async function fetchKmaForecast(signal: AbortSignal, area: IcingArea | Coordinate = 'gwanak'): Promise<KmaForecast | undefined> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const response = await fetch('/api/kma/forecast?' + weatherQuery(area), { signal: requestSignal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return undefined;
  const data: KmaForecast = await response.json();
  requestSignal.throwIfAborted();
  if (!Number.isFinite(data?.retrievedAt) || !Array.isArray(data.ultra) || !Array.isArray(data.short)) return undefined;
  return data;
}

export async function fetchKmaGrid(signal: AbortSignal, area: IcingArea | Coordinate): Promise<GridWeather> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const response = await fetch('/api/kma/grid?' + weatherQuery(area), { signal: requestSignal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return { status: 'unavailable' };
  const packet: GridWeather = await response.json();
  requestSignal.throwIfAborted();
  if (packet?.status === 'permission') return { status: 'permission' };
  if (packet?.status !== 'ok' || !Array.isArray(packet.rows)) return { status: 'unavailable' };
  const rows = packet.rows.filter(row => Number.isFinite(row?.time) &&
    [row.temperatureC, row.dewPointC, row.humidity, row.windMps, row.rain60mMm, row.snowDepthCm, row.newSnow3hCm]
      .every(value => value === null || Number.isFinite(value))).sort((a, b) => a.time - b.time);
  return rows.length ? { status: 'ok', rows } : { status: 'unavailable' };
}

export function hasFreezingRain(hour: IcingHour) {
  return hour.weatherCode !== undefined && [56, 57, 66, 67].includes(hour.weatherCode);
}

export function summarizeIcingWeather(hours: (IcingHour | undefined)[]) {
  const summary = { refreeze: false, freezingRain: false, snowmelt: false, frost: false,
    lingeringRefreeze: false, coldGround: false, incomplete: false };
  for (const hour of hours) {
    if (!hour) {
      summary.incomplete = true;
      continue;
    }
    const refreeze = hasRefreezeConditions(hour);
    const airTemperature = forecastTemperature(hour);
    if (refreeze) summary.refreeze = true;
    if (hasFreezingRain(hour)) summary.freezingRain = true;
    if (hasSnowmeltRefreeze(hour)) summary.snowmelt = true;
    if (hasFrostConditions(hour)) summary.frost = true;
    if (!refreeze && airTemperature <= 0 && hour.coldAfterMoisture) summary.lingeringRefreeze = true;
    if (airTemperature > 0 && hour.soilTemperatureC !== undefined && hour.soilTemperatureC <= 0 &&
        (hasMoistureEvidence(hour) || hour.coldAfterMoisture)) summary.coldGround = true;
    if (!refreeze && airTemperature <= 0 && hour.precedingPrecipMm === null) summary.incomplete = true;
  }
  return summary;
}

export function selectLiveIcingHour(hours: IcingHour[], selected: number | undefined, now: number) {
  const current = Math.floor(now / hourMs) * hourMs;
  return hours.find(hour => hour.time === selected && hour.time >= current) ?? hours.find(hour => hour.time === current);
}

export function readNearbyPrecipitation(payload: unknown, now: number, area: IcingArea | Coordinate = 'gwanak', maxAgeMs = icingWeatherMaxAgeMs): NearbyPrecipitation[] {
  const stations = (payload as { stations?: unknown } | null)?.stations;
  if (!Array.isArray(stations)) return [];
  const center: Coordinate = typeof area === 'string' ? [icingRegions[area].weatherCenter[0], icingRegions[area].weatherCenter[1]] : area;
  const nearby: NearbyPrecipitation[] = [];
  for (const station of stations) {
    const mm = station?.rain60mMm ?? station?.rain10mMm;
    if (typeof station?.name !== 'string' || !station.name || !Number.isFinite(station.lat) || !Number.isFinite(station.lon) ||
        !Number.isFinite(mm) || mm < 0) continue;
    const time = Date.parse(station.observedAt);
    if (!Number.isFinite(time) || time > now || now - time >= maxAgeMs) continue;
    const distanceM = distanceBetween(center, [station.lon, station.lat]);
    if (distanceM > 3000) continue;
    const reading: NearbyPrecipitation = { station: station.name, time, mm, distanceM };
    if (station.rain60mMm == null) reading.durationMs = tenMinutesMs;
    nearby.push(reading);
  }
  return nearby.sort((a, b) => a.distanceM - b.distanceM || b.time - a.time);
}

export function withNearbyPrecipitation(hour: IcingHour, observations: NearbyPrecipitation[], now: number, history: NearbyPrecipitation[] = []): IcingHour {
  const referenceTime = observationReferenceTime(hour, now);
  // The full observed accumulation interval must fall inside the lookback.
  const cutoff = Math.min(now, referenceTime);
  const withinLookback = (record: NearbyPrecipitation, lookback: number) => record.mm > 0 && record.time <= cutoff &&
    record.time - (record.durationMs ?? hourMs) >= referenceTime - lookback;
  const isRecentRain = (record: NearbyPrecipitation) => withinLookback(record, 6 * hourMs);
  const match = observations.find(record => now - record.time < icingWeatherMaxAgeMs && isRecentRain(record)) ?? history.find(isRecentRain);
  const coldHistoryStart = hour.coldHistoryStart;
  const continues = !hour.coldAfterMoisture && coldHistoryStart !== undefined && history.some(record =>
    withinLookback(record, icingRainHistoryMs) && record.time <= hour.time && record.time >= coldHistoryStart);
  if (!match && !continues) return hour;
  return { ...hour, ...(match && { nearbyPrecipitation: match }), ...(continues && { coldAfterMoisture: true }) };
}

export async function fetchPrecipitationObservations(signal: AbortSignal, source: 'latest' | 'history' | 'seoul' = 'latest') {
  const endpoint = { latest: '/api/kma/weather', history: '/api/kma/rain-history', seoul: '/api/seoul/rain-history' }[source];
  const timeoutMs = { latest: 20_000, history: 23_000, seoul: 10_000 }[source];
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await fetch(endpoint, { signal: requestSignal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
  const data: unknown = await response.json();
  requestSignal.throwIfAborted();
  return data;
}

export async function fetchNearbyPrecipitation(signal: AbortSignal, area: IcingArea = 'gwanak') {
  return readNearbyPrecipitation(await fetchPrecipitationObservations(signal), Date.now(), area);
}

export async function fetchIcingHours(signal: AbortSignal, area: IcingArea = 'gwanak') {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const url = new URL(icingForecastUrl);
  const [lon, lat] = icingRegions[area].weatherCenter;
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  const response = await fetch(url, { signal: requestSignal, cache: 'no-cache', redirect: 'error' });
  if (!response.ok) throw new Error('공개 예보를 불러오지 못했습니다.');
  const data: unknown = await response.json();
  requestSignal.throwIfAborted();
  const retrievedAt = Date.now();
  return { retrievedAt, hours: findIcingHours(data, retrievedAt) };
}

export async function fetchSeoulHours(points: Coordinate[], signal: AbortSignal) {
  const request = AbortSignal.any([signal, AbortSignal.timeout(16_000)]);
  const url = new URL(icingForecastUrl);
  url.searchParams.set('latitude', points.map(([, lat]) => lat.toFixed(4)).join(','));
  url.searchParams.set('longitude', points.map(([lon]) => lon.toFixed(4)).join(','));
  const response = await fetch(url, { signal: request, cache: 'no-cache', redirect: 'error' });
  if (!response.ok) throw new Error('서울 구간별 예보를 불러오지 못했어요.');
  const data: unknown = await response.json();
  const values = Array.isArray(data) ? data : [data];
  if (values.length !== points.length) throw new Error('서울 구간별 예보의 수가 맞지 않아요.');
  const retrievedAt = Date.now();
  return { retrievedAt, hours: values.map(value => {
    try { return findIcingHours(value, retrievedAt); } catch { return []; }
  }) };
}
export async function readIcingReplay(raw: ArrayBuffer, scene: IcingReplay = 'original') {
  const source = icingReplays[scene];
  const digest = await crypto.subtle.digest('SHA-256', raw);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== source.sha256) throw new Error('과거 예보 원본의 해시가 일치하지 않습니다.');
  const time = Date.parse(source.validAt);
  const hour = findIcingHours(JSON.parse(new TextDecoder().decode(raw)), time).find(item => item.time === time);
  if (!hour || !hasRefreezeConditions(hour)) throw new Error('시범 시각의 예보를 확인할 수 없습니다.');
  return scene === 'gangnam' ? withKmaGrid(hour, gangnamGridReplay.rows, hour.time) : hour;
}

export async function fetchIcingReplay(signal: AbortSignal, scene: IcingReplay) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  const response = await fetch(icingReplays[scene].path, { signal: requestSignal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('과거 예보 파일을 불러오지 못했습니다.');
  }
  const hour = await readIcingReplay(await response.arrayBuffer(), scene);
  requestSignal.throwIfAborted();
  return hour;
}
