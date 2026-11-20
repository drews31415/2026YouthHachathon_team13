import { readFileSync } from 'node:fs';
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import capture from '../public/data/kma-source.json' with { type: 'json' };
import stationMetadata from './kma-stations.json' with { type: 'json' };
import { KMA_MAX_AGE_MS, kmaAwsMinute, parseKmaAws, parseKmaCapture, parseKmaHourlyRain } from './kma-parser.mjs';
import { handleApi } from './api.mjs';

const now = Date.parse(capture.retrievedAt);
const options = { retrievedAt: capture.retrievedAt, now };
const wetSource = readFileSync(new URL('../../data/kma/aws-509-20250304-positive.txt', import.meta.url), 'utf8');
const wetAt = Date.parse('2025-03-04T10:00:00+09:00');

test('extracts only positive AWS amounts from the exact requested hour', () => {
  const { name, lat, lon } = stationMetadata.stations.find(station => station.id === 509);
  assert.deepEqual(parseKmaHourlyRain(wetSource, wetAt), [
    { id: 509, name, lat, lon, observedAt: new Date(wetAt).toISOString(), rain60mMm: 0.5 },
  ]);
  assert.throws(() => parseKmaHourlyRain(wetSource, wetAt + 60_000), /no-local-hourly-rain/);
  const dry = wetSource.replace(/^(\d{12},509,(?:[^,]*,){9})0\.5,/m, '$10.0,');
  assert.deepEqual(parseKmaHourlyRain(dry, wetAt), []);
  const conflictingRow = dry.split(/\r?\n/).find(line => line.startsWith('202503041000,'));
  assert.throws(() => parseKmaHourlyRain(wetSource.replace('#7777END', `${conflictingRow}\n#7777END`), wetAt), /no-local-hourly-rain/);
});

test('serves partial AWS history and shares cached hours across overlapping requests', async () => {
  const requestTime = wetAt + 2 * 3_600_000 + 10 * 60_000;
  const mock = vi.fn(async url => new URL(url).searchParams.get('tm2') === kmaAwsMinute(wetAt)
    ? new Response(wetSource) : new Response(null, { status: 503 }));
  vi.spyOn(Date, 'now').mockReturnValue(requestTime);
  vi.stubGlobal('fetch', mock);
  const request = new Request('https://example.test/api/kma/rain-history');
  try {
    const env = { KMA_API_KEY: 'test-only-key' };
    const responses = await Promise.all([handleApi(request, env), handleApi(request, env)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { stations: parseKmaHourlyRain(wetSource, wetAt), receivedHours: 1, requestedHours: 11 });
    }
    assert.equal(mock.mock.calls.length, 11);
    assert.equal((await handleApi(request, env)).status, 200);
    assert.equal(mock.mock.calls.length, 11);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

test('joins actual local station rows to official metadata, with KST converted to UTC', () => {
  const result = parseKmaAws(capture.rawText, options);
  const stations = new Map(result.stations.map(station => [station.id, station]));
  for (const id of [401, 404, 407, 410, 421, 509]) {
    assert.ok(stations.has(id));
    const official = stationMetadata.stations.find(station => station.id === id);
    assert.deepEqual([stations.get(id).lat, stations.get(id).lon], [official.lat, official.lon]);
  }
  for (const station of result.stations) {
    const cells = capture.rawText.split(/\r?\n/).find(line => new RegExp(`^\\d{12},${station.id},`).test(line)).split(',');
    assert.equal(station.temperature, Number(cells[8]));
    assert.equal(station.humidity, Number(cells[14]));
    assert.equal(station.rain60mMm, Number(cells[11]));
    assert.equal(new Date(Date.parse(station.observedAt) + 9 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0,12), cells[0]);
  }
  assert.equal(stations.get(509).lat, 37.45284);
  assert.equal(stations.get(509).lon, 126.95015);
  assert.equal(stations.get(509).name, '관악');
  assert.equal(result.units.humidity, '%');
  assert.equal(result.units.rain60mMm, 'mm/60min');
});

test('keeps actual provider missing rain detection unknown instead of claiming dry', () => {
  const result = parseKmaAws(capture.rawText, options);
  for (const station of result.stations) {
    const row = capture.rawText.split(/\r?\n/).find(line => new RegExp(`^\\d{12},${station.id},`).test(line)).split(',');
    if (Number(row[9]) < 0) {
      assert.equal(station.rainDetected, null);
      assert.ok(station.missingFields.includes('rainDetected'));
    }
  }
});

test('capture hash and original acquisition time remain verifiable', async () => {
  const result = await parseKmaCapture(capture, now + 60000);
  assert.equal(result.retrievedAt, capture.retrievedAt);
  assert.equal(result.retrievalMode, 'captured');
  assert.equal(result.sha256, capture.sha256);
});

test('rejects expired actual observations regardless of a refreshed retrieval timestamp', async () => {
  const baseline = parseKmaAws(capture.rawText, options);
  const later = Date.parse(baseline.observedAt) + KMA_MAX_AGE_MS + 1;
  assert.throws(() => parseKmaAws(capture.rawText, { retrievedAt: new Date(later).toISOString(), now: later }), /no-fresh-local-observations/);
  await assert.rejects(parseKmaCapture(capture, later), /no-fresh-local-observations/);
});

test('rejects changed source, modified bytes, HTML response and missing local rows', async () => {
  await assert.rejects(parseKmaCapture({ ...capture, endpoint: 'https://example.com/' }, now), /invalid-captured-source/);
  await assert.rejects(parseKmaCapture({ ...capture, rawText: `${capture.rawText}\n` }, now), /invalid-captured-source/);
  assert.throws(() => parseKmaAws('<html>error</html>', options), /unknown-response-format/);
  const knownIds = new Set(stationMetadata.stations.map(station => station.id));
  const withoutLocalRows = capture.rawText.split(/\r?\n/).filter(line => !knownIds.has(Number(line.match(/^\d{12},(\d+),/)?.[1]))).join('\n');
  assert.throws(() => parseKmaAws(withoutLocalRows, options), /no-fresh-local-observations/);
});

test('rejects an acquisition date earlier than the actual observation', () => {
  const baseline = parseKmaAws(capture.rawText, options);
  const before = Date.parse(baseline.observedAt) - 3600000;
  assert.throws(() => parseKmaAws(capture.rawText, { retrievedAt: new Date(before).toISOString(), now }), /invalid-observation-time/);
});
