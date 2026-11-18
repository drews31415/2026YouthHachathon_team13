import { describe, expect, it } from 'vitest';
import { parseWeather } from './weather';

const now = Date.UTC(2026, 10, 18, 9, 15);
const end = Math.floor(now / 3_600_000) * 3600;
function payload() {
  return {
    current: { time: now / 1000, temperature_2m: -1.5 },
    current_units: { time: 'unixtime', temperature_2m: '°C' },
    hourly: {
      time: Array.from({ length: 26 }, (_, i) => end - (24 - i) * 3600),
      precipitation: Array.from({ length: 26 }, (_, i) => i === 25 ? 100 : 0.5),
      snowfall: Array.from({ length: 26 }, () => 0.1),
    },
    hourly_units: { precipitation: 'mm', snowfall: 'cm' },
  };
}
describe('real weather provenance and missing data', () => {
  it('sums exactly the preceding 24 hours and excludes future forecast rainfall', () => {
    const result = parseWeather(payload(), now);
    expect(result.precipitation24hMm).toBe(12);
    expect(result.snowfall24hCm).toBe(2.4);
    expect(result.hourlySamples).toBe(24);
  });
  it('does not turn null rainfall into zero', () => {
    const input = payload();
    (input.hourly.precipitation as unknown[])[10] = null;
    expect(parseWeather(input, now).precipitation24hMm).toBeNull();
  });
  it('rejects stale weather instead of presenting it as current', () => {
    expect(() => parseWeather(payload(), now + 3 * 3600_000)).toThrow('기준 시각');
  });
  it('rejects future or missing temperature', () => {
    expect(() => parseWeather(payload(), now - 3600_000)).toThrow('기준 시각');
    const input = payload();
    (input.current as Record<string, unknown>).temperature_2m = null;
    expect(() => parseWeather(input, now)).toThrow('누락');
  });
  it('returns unknown when samples are missing or duplicated', () => {
    const input = payload();
    input.hourly.time[10] = input.hourly.time[11];
    expect(parseWeather(input, now).precipitation24hMm).toBeNull();
  });
});
