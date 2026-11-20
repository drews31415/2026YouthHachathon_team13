import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { handleApi } from './api.mjs';
import { normalizeSeoulRain } from './seoul-rain.mjs';

const time = Date.parse('2026-11-20T17:50:00+09:00');
const valid = { RF_CD: '301', RF_NM: '도봉구청', DATA_CLCT_TM: '2026-11-20 17:49', RN_10M: '0.5' };

test('assigns the end of the city accumulation interval and uses only matched gauges', () => {
  const { stations, verifiedRows, stationCount } = normalizeSeoulRain([
    valid,
    valid,
    { ...valid, RF_CD: '1104', RF_NM: '서소문' },
    { ...valid, RF_NM: '노원구청' },
    { ...valid, DATA_CLCT_TM: '2026-11-20 17:50' },
    { ...valid, DATA_CLCT_TM: '2026-11-20 17:59' },
    { ...valid, DATA_CLCT_TM: '2026-11-20 05:49' },
    { ...valid, DATA_CLCT_TM: '2026-11-20 17:39', RN_10M: '-1' },
  ], time);
  assert.equal(verifiedRows, 1);
  assert.equal(stationCount, 1);
  assert.deepEqual(stations, [{ id: '301', name: '도봉구청', lon: 127.0470994, lat: 37.6687059,
    observedAt: new Date(time).toISOString(), rain10mMm: 0.5 }]);
  assert.equal(normalizeSeoulRain([valid, { ...valid, RN_10M: '0' }, valid], time).verifiedRows, 0);
  assert.equal(normalizeSeoulRain([{ ...valid, RN_10M: '0' }], time).verifiedRows, 1);
});

test('serves verified city history during a partial outage and reuses the acquisition', async () => {
  const mockedFetch = vi.fn(async (_url, options) => {
    const pageNo = Number(new URLSearchParams(options.body).get('pageNo'));
    return pageNo === 1 ? Response.json({ result: 'ok', page: { pageNo }, list: [valid] }) : new Response(null, { status: 503 });
  });
  vi.spyOn(Date, 'now').mockReturnValue(time);
  vi.stubGlobal('fetch', mockedFetch);
  try {
    const request = new Request('https://example.test/api/seoul/rain-history');
    const responses = await Promise.all([handleApi(request), handleApi(request)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.receivedPages, 1);
      assert.deepEqual(data.stations, normalizeSeoulRain([valid], time).stations);
    }
    assert.equal((await handleApi(request)).status, 200);
    assert.equal(mockedFetch.mock.calls.length, 4);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
