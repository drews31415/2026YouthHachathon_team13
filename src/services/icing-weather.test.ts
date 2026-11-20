import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findIcingHours, forecastTemperature, hasRefreezeConditions, selectLiveIcingHour, summarizeIcingWeather,
  icingRainHistoryMs, readNearbyPrecipitation, withKmaGrid, withNearbyPrecipitation } from './icing-weather';

const validAt = Date.parse('2025-01-27T11:00:00+09:00');
const source = JSON.parse(readFileSync(new URL('../../public/data/icing-replay.json', import.meta.url), 'utf8'));
const index = source.hourly.time.indexOf(validAt / 1000);

describe('icing forecast with missing inputs', () => {
  it('keeps the archived hour and its positive precipitation evidence when one reading is missing', () => {
    const packet = structuredClone(source);
    const zeroIndex = packet.hourly.precipitation.findIndex((amount: number, i: number) => i >= index - 5 && i <= index && amount === 0);
    expect(zeroIndex).toBeGreaterThanOrEqual(0);
    packet.hourly.precipitation[zeroIndex] = null;

    const hour = findIcingHours(packet, validAt)[0];
    expect(hour).toMatchObject({ time: validAt, temperatureC: source.hourly.temperature_2m[index], precedingPrecipMm: null, recentPrecipitation: true });
    expect(summarizeIcingWeather([hour])).toMatchObject({ refreeze: true, incomplete: false });
  });

  it('keeps freezing rain visible when the precipitation series is unavailable', () => {
    const packet = structuredClone(source);
    delete packet.hourly.precipitation;
    delete packet.hourly_units.precipitation;
    packet.hourly_units.weather_code = 'wmo code';
    packet.hourly.weather_code = [];
    packet.hourly.weather_code[index] = 66;

    const hour = findIcingHours(packet, validAt)[0];
    expect(hour.precedingPrecipMm).toBeNull();
    expect(summarizeIcingWeather([hour])).toMatchObject({ refreeze: false, freezingRain: true, incomplete: true });
  });

  it('keeps simultaneous weather signals and missing zones in the same summary', () => {
    const wet = findIcingHours(source, validAt)[0];
    const freezingRain = { ...wet, temperatureC: 1, weatherCode: 66 };
    const frost = { ...wet, precedingPrecipMm: 0, coldAfterMoisture: undefined, dewPointC: -1, windKmh: 2, solarWm2: 0 };
    const snowmelt = { ...wet, recentThawOnSnow: true };

    expect(summarizeIcingWeather([freezingRain, wet, frost, snowmelt, undefined])).toEqual({
      freezingRain: true, refreeze: true, frost: true, snowmelt: true,
      lingeringRefreeze: false, coldGround: false, incomplete: true,
    });
  });

  it('uses the current hour unless a current or future hour is explicitly selected', () => {
    const hours = findIcingHours(source, validAt);
    const [current, future] = hours;
    expect(future.time).toBeGreaterThan(current.time);
    expect(selectLiveIcingHour(hours, undefined, validAt + 30 * 60_000)).toBe(current);
    expect(selectLiveIcingHour(hours, future.time, validAt)).toBe(future);
    expect(selectLiveIcingHour(hours, current.time, future.time)).toBe(future);
    expect(selectLiveIcingHour(hours.slice(1), undefined, validAt)).toBeUndefined();
  });
});

describe('regional icing alerts from the weather history', () => {
  it.each([6, 11, 12])('bounds the regional alert after precipitation ending %i hours ago', offset => {
    const packet = structuredClone(source);
    packet.hourly.precipitation.fill(0);
    packet.hourly.precipitation[index - offset] = 1;
    packet.hourly.temperature_2m.fill(-1);

    const hour = findIcingHours(packet, validAt)[0];
    expect(hasRefreezeConditions(hour)).toBe(false);
    expect(summarizeIcingWeather([hour]).lingeringRefreeze).toBe(offset < 12);
  });

  it.each([1, null])('does not carry a wet signal across a warmer or missing hour (%s)', interruptedTemperature => {
    const packet = structuredClone(source);
    packet.hourly.precipitation.fill(0);
    packet.hourly.precipitation[index - 8] = 1;
    packet.hourly.temperature_2m.fill(-1);
    packet.hourly.temperature_2m[index - 3] = interruptedTemperature;

    expect(summarizeIcingWeather([findIcingHours(packet, validAt)[0]]).lingeringRefreeze).toBe(false);
  });

  it('does not use a later thaw to clear the current regional alert', () => {
    const packet = structuredClone(source);
    packet.hourly.precipitation.fill(0);
    packet.hourly.precipitation[index - 8] = 1;
    packet.hourly.temperature_2m.fill(-1);
    packet.hourly.temperature_2m[index + 1] = 3;

    const hours = findIcingHours(packet, validAt);
    expect(summarizeIcingWeather([hours[0]]).lingeringRefreeze).toBe(true);
    expect(summarizeIcingWeather([hours[1]]).lingeringRefreeze).toBe(false);
  });

  it('uses a valid cold ground estimate with moisture for a regional alert only', () => {
    const packet = structuredClone(source);
    packet.hourly.temperature_2m[index] = 1;
    packet.hourly_units.soil_temperature_0cm = '°C';
    packet.hourly.soil_temperature_0cm = [];
    packet.hourly.soil_temperature_0cm[index] = -0.2;

    const hour = findIcingHours(packet, validAt)[0];
    expect(hour.soilTemperatureC).toBe(-0.2);
    expect(hasRefreezeConditions(hour)).toBe(false);
    expect(summarizeIcingWeather([hour]).coldGround).toBe(true);

    packet.hourly.precipitation.fill(0);
    expect(summarizeIcingWeather([findIcingHours(packet, validAt)[0]]).coldGround).toBe(false);
    packet.hourly_units.soil_temperature_0cm = '°F';
    expect(findIcingHours(packet, validAt)[0].soilTemperatureC).toBeUndefined();
  });
});

it('uses observations through now for the current hour without substituting later grid temperatures', () => {
  const [hour] = findIcingHours(source, validAt);
  const halfHour = validAt + 30 * 60_000;
  const now = halfHour + 5 * 60_000;
  const observedRain = { station: '관악', time: halfHour, mm: 1, distanceM: 1000 };
  const gridRows = [
    { time: validAt, temperatureC: -2, dewPointC: null, humidity: null, windMps: null, rain60mMm: 0, snowDepthCm: null, newSnow3hCm: null },
    { time: halfHour, temperatureC: 2, dewPointC: null, humidity: null, windMps: null, rain60mMm: 1, snowDepthCm: null, newSnow3hCm: null },
  ];
  expect(withNearbyPrecipitation(hour, [observedRain], now).nearbyPrecipitation).toBe(observedRain);
  expect(withNearbyPrecipitation(hour, [observedRain], halfHour - 1).nearbyPrecipitation).toBeUndefined();
  const withGrid = withKmaGrid(hour, gridRows, now);
  expect(withGrid.gridMoisture).toBe(true);
  expect(forecastTemperature(withGrid)).toBe(-2);
  expect(withKmaGrid(hour, gridRows, halfHour - 1).gridMoisture).toBe(false);
});

describe('AWS precipitation history', () => {
  const hourMs = 3_600_000;
  const recordedRain = (time: number) => ({ station: '관악', time, mm: 0.5, distanceM: 1000 });

  it('supplements the six-hour moisture signal only with complete past observation intervals', () => {
    const hour = { time: validAt, temperatureC: -1, precedingPrecipMm: 0 };
    const rain = recordedRain(validAt - 5 * hourMs);
    expect(hasRefreezeConditions(withNearbyPrecipitation(hour, [rain], validAt))).toBe(false);
    const supplemented = withNearbyPrecipitation(hour, [], validAt, [rain]);
    expect(supplemented.nearbyPrecipitation).toBe(rain);
    expect(hasRefreezeConditions(supplemented)).toBe(true);
    expect(withNearbyPrecipitation(hour, [], validAt, [recordedRain(rain.time - 60_000)])).toBe(hour);
    expect(withNearbyPrecipitation({ ...hour, time: validAt + hourMs }, [], validAt, [recordedRain(validAt + 60_000)]).nearbyPrecipitation).toBeUndefined();
  });

  it('carries older AWS rain into regional caution only while the cold history is continuous', () => {
    const packet = structuredClone(source);
    packet.hourly.temperature_2m.fill(-1);
    packet.hourly.precipitation.fill(0);
    const rain = recordedRain(validAt - 8 * hourMs);
    const assess = () => withNearbyPrecipitation(findIcingHours(packet, validAt)[0], [], validAt, [rain]);

    const extended = assess();
    expect(summarizeIcingWeather([extended])).toMatchObject({ refreeze: false, lingeringRefreeze: true });
    packet.hourly.temperature_2m[index - 4] = null;
    expect(summarizeIcingWeather([assess()]).lingeringRefreeze).toBe(false);
  });

  it('filters historical rows by station distance and age without relaxing the latest-only window', () => {
    const [lon, lat] = [126.9516, 37.4784];
    const stations = [
      { name: 'nearby', lon, lat, observedAt: new Date(validAt - 7 * hourMs).toISOString(), rain60mMm: 0.5 },
      { name: 'far', lon: lon - 0.1, lat, observedAt: new Date(validAt - 7 * hourMs).toISOString(), rain60mMm: 1 },
      { name: 'expired', lon, lat, observedAt: new Date(validAt - 12 * hourMs).toISOString(), rain60mMm: 1 },
    ];
    expect(readNearbyPrecipitation({ stations }, validAt)).toEqual([]);
    expect(readNearbyPrecipitation({ stations }, validAt, [lon, lat], icingRainHistoryMs).map(row => row.station)).toEqual(['nearby']);
  });
});

it('applies the city ten-minute interval at the six-hour boundary without reinterpreting AWS totals', () => {
  const tenMinutesMs = 600_000;
  const start = validAt - 6 * 3_600_000;
  const [lon, lat] = [126.9516, 37.4784];
  const stations = [{ name: '서울시 강우량계', lon, lat, observedAt: new Date(start + tenMinutesMs).toISOString(), rain10mMm: 0.5 }];
  const observations = readNearbyPrecipitation({ stations }, validAt, [lon, lat], icingRainHistoryMs);
  const hour = { time: validAt, temperatureC: -1, precedingPrecipMm: 0 };
  expect(observations[0]).toMatchObject({ durationMs: tenMinutesMs, mm: 0.5 });
  expect(hasRefreezeConditions(withNearbyPrecipitation(hour, [], validAt, observations))).toBe(true);
  expect(hasRefreezeConditions(withNearbyPrecipitation(hour, [], validAt + 1, observations))).toBe(false);
  expect(hasRefreezeConditions(withNearbyPrecipitation(hour, [], validAt, [{ ...observations[0], durationMs: undefined }]))).toBe(false);
});
