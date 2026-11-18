/** Real model weather, never a measurement of pavement ice. No user location is transmitted. */
export interface WeatherSnapshot {
  temperatureC: number;
  precipitation24hMm: number | null;
  snowfall24hCm: number | null;
  weatherTime: string;
  retrievedAt: string;
  hourlySamples: number;
  source: 'Open-Meteo';
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
    source: 'Open-Meteo',
  };
}

export async function fetchWeather(signal?: AbortSignal): Promise<WeatherSnapshot> {
  const timeout = AbortSignal.timeout(12_000);
  const response = await fetch(WEATHER_URL, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`기상자료를 불러오지 못했습니다 (${response.status}). 잠시 후 다시 시도해 주세요.`);
  return parseWeather(await response.json());
}
