export const icingForecastUrl = 'https://api.open-meteo.com/v1/forecast?latitude=37.4784&longitude=126.9516&hourly=temperature_2m,precipitation&past_days=1&forecast_days=2&timeformat=unixtime&timezone=GMT';
const hourSeconds = 3600;
export const icingWeatherMaxAgeMs = 30 * 60_000;

export interface IcingHour {
  time: number;
  temperatureC: number;
  precedingPrecipMm: number;
}

interface ForecastPayload {
  hourly_units?: { time?: string; temperature_2m?: string; precipitation?: string };
  hourly?: { time?: unknown[]; temperature_2m?: unknown[]; precipitation?: unknown[] };
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
    if (amounts.length === 6) hours.push({ time: time * 1000, temperatureC, precedingPrecipMm: amounts.reduce((a, b) => a + b, 0) });
  }
  if (!hours.length) throw new Error('최근 강수를 포함한 시간별 예보를 확인할 수 없습니다.');
  return hours;
}

export function hasRefreezeConditions(hour: IcingHour) {
  return hour.temperatureC <= 0 && hour.precedingPrecipMm > 0;
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
