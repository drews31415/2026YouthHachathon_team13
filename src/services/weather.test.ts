import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import actual from './fixtures/weather.json';
import source from './fixtures/weather-provenance.json';
import { fetchWeather, parseCapturedWeather, parseWeather, WEATHER_URL } from './weather';

const capturedAt = Date.parse(source.retrievedAt);
const actualRaw = readFileSync(new URL('./fixtures/weather.json', import.meta.url), 'utf8');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('acquired Open-Meteo response, without generated weather', () => {
  it('matches the captured response checksum', () => {
    const bytes = readFileSync(new URL('./fixtures/weather.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
  });
  it('retains the actual source temperature and timestamp', () => {
    const result = parseWeather(actual, capturedAt);
    expect(result.temperatureC).toBe(actual.current.temperature_2m);
    expect(result.weatherTime).toBe(new Date(actual.current.time * 1000).toISOString());
    expect(result.hourlySamples).toBe(24);
  });
  it('sums only actual preceding hourly records', () => {
    const end = Math.floor(actual.current.time / 3600) * 3600;
    const indexes = actual.hourly.time.flatMap((time, i) => time <= end && time > end - 24 * 3600 ? [i] : []);
    const sum = indexes.reduce((total, i) => total + actual.hourly.precipitation[i], 0);
    expect(parseWeather(actual, capturedAt).precipitation24hMm).toBe(Math.round(sum * 100) / 100);
  });
  it('does not fill a missing real record with zero', () => {
    const incomplete = structuredClone(actual);
    incomplete.hourly.precipitation.length = 0;
    expect(parseWeather(incomplete, capturedAt).precipitation24hMm).toBeNull();
  });
  it('rejects the actual response once stale', () => {
    expect(() => parseWeather(actual, capturedAt + 3 * 3600_000)).toThrow('기준 시각');
  });
  it('rejects missing temperature rather than supplying a default', () => {
    const incomplete: any = structuredClone(actual);
    delete incomplete.current.temperature_2m;
    expect(() => parseWeather(incomplete, capturedAt)).toThrow('누락');
  });
});

describe('verified captured response after a failed live request', () => {
  it('publishes the exact acquired bytes and provenance without changing the capture time', () => {
    expect(readFileSync(new URL('../../public/data/weather.json', import.meta.url), 'utf8')).toBe(actualRaw);
    expect(readFileSync(new URL('../../public/data/weather-provenance.json', import.meta.url), 'utf8'))
      .toBe(readFileSync(new URL('./fixtures/weather-provenance.json', import.meta.url), 'utf8'));
  });

  it('preserves actual acquisition time while checking freshness at the later display time', async () => {
    const displayTime = capturedAt + 20 * 60_000;
    const result = await parseCapturedWeather(actualRaw, source, displayTime);
    expect(result.retrievalMode).toBe('captured');
    expect(result.retrievedAt).toBe(source.retrievedAt);
    expect(result.retrievedAt).not.toBe(new Date(displayTime).toISOString());
    expect(result.temperatureC).toBe(actual.current.temperature_2m);
    expect(result.weatherTime).toBe(new Date(actual.current.time * 1000).toISOString());
    expect(result.periodStartedAt).toBe(parseWeather(actual, capturedAt).periodStartedAt);
    expect(result.periodEndedAt).toBe(parseWeather(actual, capturedAt).periodEndedAt);
  });

  it('rejects a real capture whose weather timestamp is more than two hours old', async () => {
    await expect(parseCapturedWeather(actualRaw, source, actual.current.time * 1000 + 2 * 3600_000 + 1)).rejects.toThrow('기준 시각');
  });

  it('rejects a changed source URL, capture location or acquisition time', async () => {
    await expect(parseCapturedWeather(actualRaw, { ...source, url: 'https://example.invalid/weather' }, capturedAt)).rejects.toThrow('출처');
    await expect(parseCapturedWeather(actualRaw, { ...source, latitude: null }, capturedAt)).rejects.toThrow('출처');
    await expect(parseCapturedWeather(actualRaw, { ...source, retrievedAt: new Date(capturedAt + 1).toISOString() }, capturedAt)).rejects.toThrow('수집 시각');
  });

  it('rejects mismatched bytes instead of showing a default weather value', async () => {
    await expect(parseCapturedWeather(`${actualRaw}\n`, source, capturedAt)).rejects.toThrow('해시');
  });

  it('uses only the real verified capture after a live connection failure', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(capturedAt + 20 * 60_000);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === WEATHER_URL) throw new TypeError('Network unavailable');
      return new Response(String(input).endsWith('weather-provenance.json') ? JSON.stringify(source) : actualRaw,
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchWeather();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.retrievalMode).toBe('captured');
    expect(result.retrievedAt).toBe(source.retrievedAt);
    expect(result.temperatureC).toBe(actual.current.temperature_2m);
  });

  it('reports missing capture files rather than replacing them with fabricated data', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === WEATHER_URL) throw new TypeError('Network unavailable');
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWeather()).rejects.toThrow('수집본 파일');
  });

  it('does not return a capture after the caller cancels or a newer request supersedes it', async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn(async () => { abort.abort(); throw abort.signal.reason; });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWeather(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('also honors cancellation while captured-file verification is in progress', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(capturedAt + 20 * 60_000);
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === WEATHER_URL) throw new TypeError('Network unavailable');
      if (String(input).endsWith('weather-provenance.json')) abort.abort();
      return new Response(String(input).endsWith('weather-provenance.json') ? JSON.stringify(source) : actualRaw,
        { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await expect(fetchWeather(abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
