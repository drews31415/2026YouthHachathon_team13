import replaySource from '../icing-replay-source.json';
import snowReplaySource from '../icing-snow-replay-source.json';
import gangnamReplaySource from '../icing-gangnam-replay-source.json';
import gangnamGridReplay from '../icing-gangnam-grid-replay.json';
import icingRegions from '../../icing-regions.json';
import { distanceBetween } from '../core/network';
import type { Coordinate } from '../core/types';

export const icingForecastUrl = 'https://api.open-meteo.com/v1/forecast?latitude=37.4784&longitude=126.9516&hourly=temperature_2m,precipitation,weather_code,snow_depth,snowfall,dew_point_2m,wind_speed_10m,shortwave_radiation&past_days=1&forecast_days=2&timeformat=unixtime&timezone=GMT';
const hourSeconds = 3600;
const hourMs = 3600_000;
export const icingWeatherMaxAgeMs = 30 * 60_000;
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
}

export interface IcingHour {
  time: number;
  temperatureC: number;
  precedingPrecipMm: number | null;
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
      const rainIndex = indexes.get(ending);
      const amount = rainIndex === undefined ? undefined : hourly.precipitation[rainIndex];
      if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) amounts.push(amount);
    }
    if (amounts.length !== 6) continue;
    const code = units.weather_code === 'wmo code' && Array.isArray(hourly.weather_code) ? hourly.weather_code[index] : undefined;
    const forecast: IcingHour = { time: time * 1000, temperatureC, precedingPrecipMm: amounts.reduce((a, b) => a + b, 0) };
    if (typeof code === 'number' && Number.isInteger(code)) forecast.weatherCode = code;
    forecast.snowDepthM = read('snow_depth', 'm', index);
    forecast.snowfallCm = read('snowfall', 'cm', index);
    forecast.dewPointC = read('dew_point_2m', '°C', index, -100);
    forecast.windKmh = read('wind_speed_10m', 'km/h', index);
    forecast.solarWm2 = read('shortwave_radiation', 'W/m²', index);
    for (let offset = 0; offset <= 12; offset++) {
      const past = indexes.get(time - offset * hourSeconds);
      if (offset < 6 && (read('snowfall', 'cm', past) ?? 0) > 0) forecast.recentSnowfall = true;
      if (offset > 0 && (read('snow_depth', 'm', past) ?? 0) > 0 &&
          (read('temperature_2m', '°C', past, -100) ?? 0) > 0) forecast.recentThawOnSnow = true;
    }
    // Keep archived records with omitted variables unchanged.
    for (const key of ['snowDepthM', 'snowfallCm', 'dewPointC', 'windKmh', 'solarWm2'] as const) {
      if (forecast[key] === undefined) delete forecast[key];
    }
    hours.push(forecast);
  }
  if (!hours.length) throw new Error('최근 강수를 포함한 시간별 예보를 확인할 수 없습니다.');
  return hours;
}

export function hasRefreezeConditions(hour: IcingHour) {
  return forecastTemperature(hour) <= 0 &&
    ((hour.precedingPrecipMm ?? 0) > 0 || hour.kma?.wet === true || (hour.nearbyPrecipitation?.mm ?? 0) > 0 ||
      hour.recentSnowfall === true || hour.gridMoisture === true || hasSnowmeltRefreeze(hour));
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

export function withKmaGrid(hour: IcingHour, rows: KmaGridRow[], now: number): IcingHour {
  const candidates = rows.filter(row => row.time <= Math.min(now, hour.time) && row.time >= now - 90 * 60_000);
  const grid = candidates.at(-1);
  if (!grid) return hour;
  const gridMoisture = candidates.some(row => {
    const age = hour.time - row.time;
    return ((row.rain60mMm ?? 0) > 0 && age <= 5 * hourMs) ||
      ((row.newSnow3hCm ?? 0) > 0 && age <= 3 * hourMs) ||
      ((row.snowDepthCm ?? 0) > 0 && age <= 2 * hourMs);
  });
  return { ...hour, grid, gridMoisture };
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

export async function fetchKmaForecast(signal: AbortSignal, area: IcingArea = 'gwanak'): Promise<KmaForecast | undefined> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const response = await fetch('/api/kma/forecast?area=' + area, { signal: requestSignal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return undefined;
  const data: KmaForecast = await response.json();
  requestSignal.throwIfAborted();
  if (!Number.isFinite(data?.retrievedAt) || !Array.isArray(data.ultra) || !Array.isArray(data.short)) return undefined;
  return data;
}

export async function fetchKmaGrid(signal: AbortSignal, area: IcingArea | Coordinate): Promise<GridWeather> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
  const query = typeof area === 'string' ? new URLSearchParams({ area }) : new URLSearchParams({ lon: String(area[0]), lat: String(area[1]) });
  const response = await fetch('/api/kma/grid?' + query, { signal: requestSignal, cache: 'no-store' });
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

export function readNearbyPrecipitation(payload: unknown, now: number, area: IcingArea = 'gwanak'): NearbyPrecipitation[] {
  const stations = (payload as { stations?: unknown } | null)?.stations;
  if (!Array.isArray(stations)) return [];
  const nearby: NearbyPrecipitation[] = [];
  for (const station of stations) {
    if (typeof station?.name !== 'string' || !station.name || !Number.isFinite(station.lat) || !Number.isFinite(station.lon) ||
        !Number.isFinite(station.rain60mMm) || station.rain60mMm < 0) continue;
    const time = Date.parse(station.observedAt);
    if (!Number.isFinite(time) || time > now || now - time >= icingWeatherMaxAgeMs) continue;
    const [lon, lat] = icingRegions[area].weatherCenter;
    const distanceM = distanceBetween([lon, lat], [station.lon, station.lat]);
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

export async function fetchNearbyPrecipitation(signal: AbortSignal, area: IcingArea = 'gwanak') {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(14_000)]);
  const response = await fetch('/api/kma/weather', { signal: requestSignal, cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return [];
  const data: unknown = await response.json();
  requestSignal.throwIfAborted();
  return readNearbyPrecipitation(data, Date.now(), area);
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
  return { retrievedAt, hours: values.map(value => findIcingHours(value, retrievedAt)) };
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
