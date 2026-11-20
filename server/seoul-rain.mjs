import stationFile from './seoul-rain-stations.json' with { type: 'json' };
import { parseSeoulSheet, SEOUL_SHEET_ENDPOINT, SEOUL_SHEET_REQUEST, seoulTimestamp } from './seoul.mjs';

const locations = new Map(stationFile.stations.map(({ id, name, lat, lon }) => [id, { id, name, lat, lon }]));
const minuteMs = 60_000;
const lookbackMs = 12 * 60 * minuteMs;
const catalog = 'https://data.seoul.go.kr/dataList/OA-23092/S/1/datasetView.do';
// The Sheet advances by 100 source rows per page even when it returns 1,000 rows.
// Keep 100 rows of overlap to allow for a new 10-minute update across requests.
const pages = [1, 10, 19, 28];
let cached = null;
let pending = null;

export function normalizeSeoulRain(rows, now) {
  const observations = new Map();
  for (const row of rows) {
    const location = locations.get(String(row?.RF_CD ?? '').trim());
    if (!location || String(row.RF_NM ?? '').trim() !== location.name) continue;
    const collected = String(row.DATA_CLCT_TM ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:[0-5]9$/.test(collected)) continue;
    const time = Date.parse(seoulTimestamp(collected + ':00')) + minuteMs;
    if (!Number.isFinite(time) || time > now || time - 10 * minuteMs < now - lookbackMs) continue;
    const amount = String(row.RN_10M ?? '').trim();
    if (!/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) > 300) continue;
    const key = `${location.id}/${time}`;
    const prior = observations.get(key);
    if (prior !== undefined && prior?.rain10mMm !== Number(amount)) {
      observations.set(key, null);
      continue;
    }
    observations.set(key, { ...location, observedAt: new Date(time).toISOString(), rain10mMm: Number(amount) });
  }
  const valid = [...observations.values()].filter(Boolean);
  return { stations: valid.filter(row => row.rain10mMm > 0), verifiedRows: valid.length,
    stationCount: new Set(valid.map(row => row.id)).size };
}

async function readPage(pageNo) {
  const response = await fetch(SEOUL_SHEET_ENDPOINT, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest', Referer: catalog },
    body: new URLSearchParams({ ...SEOUL_SHEET_REQUEST, infId: 'OA-23092', strOrderby: 'DATA_CLCT_TM DESC, RF_CD ASC', pageNo: String(pageNo) }).toString() });
  if (!response.ok) throw new Error('seoul-rain-upstream');
  const packet = parseSeoulSheet(await response.text());
  if (Number(packet.page?.pageNo) !== pageNo) throw new Error('seoul-rain-page');
  return packet.list;
}

export async function getSeoulRainHistory() {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!pending) pending = Promise.allSettled(pages.map(readPage)).then(results => {
    const rows = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    const now = Date.now();
    const rain = normalizeSeoulRain(rows, now);
    if (!rain.verifiedRows) throw new Error('seoul-rain-unavailable');
    const receivedPages = results.filter(result => result.status === 'fulfilled' && result.value.length > 0).length;
    const value = { ...rain, receivedPages, sourceUrl: catalog };
    cached = { value, expiresAt: now + (receivedPages === pages.length ? 5 : 1) * minuteMs };
    return value;
  }).finally(() => { pending = null; });
  return pending;
}
