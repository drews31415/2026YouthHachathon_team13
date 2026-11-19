// Server/Worker only. Never import this module into client code with credentials.
import stationFile from '../public/data/seoul-stations.json' with { type: 'json' };

export const SEOUL_CATALOG = 'https://data.seoul.go.kr/dataList/OA-22833/A/1/datasetView.do';
export const SEOUL_LICENSE = '공공누리 제1유형: 출처표시 (상업적 이용 및 변경 가능)';
export const SEOUL_SHEET_ENDPOINT = 'https://data.seoul.go.kr/dataList/dataView.do';
export const SEOUL_SHEET_REQUEST = Object.freeze({ onepagerow: '1000', srvType: 'S', infId: 'OA-22833', serviceKind: '0', pageNo: '1', gridTotalCnt: '', ssUserId: 'SAMPLE_VIEW', strWhere: '', strOrderby: 'SENSING_TIME DESC', filterCol: '', txtFilter: '' });
const locations = new Map(stationFile.stations.map(station => [station.id, station]));
const defaultEnv = () => typeof process === 'object' ? process.env : {};
const fixedError = code => Object.assign(new Error(code), { code });

/** Original Seoul source omits zone offsets. The declared interpretation is KST. */
export function seoulTimestamp(value) {
  const match = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})[T_ ](\d{2})[:-](\d{2})[:-](\d{2})$/);
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}+09:00`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  // Date.parse normalizes impossible dates; reject those instead of inventing time.
  const local = new Date(time + 9 * 3600_000).toISOString().slice(0, 19);
  return local === iso.slice(0, 19) ? iso : null;
}

function measurement(value, minimum, maximum) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

/** Normalizes only actual source rows. DATA_NO=2 supersedes 1 at the same sensor/time. */
export function normalizeSeoulRows(rows, { retrievedAt, sourceKind = 'api-observation', sourceFile = null } = {}) {
  if (!Number.isFinite(Date.parse(retrievedAt))) throw fixedError('SEOUL_INVALID_RETRIEVAL_TIME');
  const byTime = new Map();
  let rejectedRows = 0;
  for (const row of rows) {
    const id = String(row.SERIAL ?? '').trim();
    if (!locations.has(id)) continue;
    const observedAt = seoulTimestamp(row.SENSING_TIME);
    if (!observedAt || Date.parse(observedAt) > Date.parse(retrievedAt) + 5 * 60_000) { rejectedRows++; continue; }
    const dataNo = Number(row.DATA_NO);
    if (![1, 2].includes(dataNo)) { rejectedRows++; continue; }
    const collectedAt = seoulTimestamp(row.DATE);
    const key = `${id}|${observedAt}`;
    const candidate = { id, observedAt, collectedAt, dataNo,
      rawObservedAt: String(row.SENSING_TIME), rawCollectedAt: String(row.DATE ?? ''),
      temperature: measurement(row.AVG_TEMP, -90, 60), humidity: measurement(row.AVG_HUMI, 0, 100),
      sourceRow: row.sourceRow ?? null };
    const prior = byTime.get(key);
    if (!prior || dataNo > prior.dataNo || (dataNo === prior.dataNo && Date.parse(collectedAt ?? '') > Date.parse(prior.collectedAt ?? ''))) byTime.set(key, candidate);
  }
  const latest = new Map();
  for (const row of byTime.values()) {
    const prior = latest.get(row.id);
    if (!prior || Date.parse(row.observedAt) > Date.parse(prior.observedAt)) latest.set(row.id, row);
  }
  const stations = [...latest.values()].map(row => {
    const location = locations.get(row.id);
    return { ...row, name: location.name, lat: location.lat, lon: location.lon,
      locationSourceRow: location.sourceRow,
      quality: row.temperature === null || row.humidity === null ? 'missing-measurement' : 'observed' };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const times = stations.map(station => station.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    source: '서울특별시 S-DoT 실제 환경 관측', sourceUrl: SEOUL_CATALOG,
    sourceKind, sourceFile, historical: sourceKind === 'weekly-archive' || sourceKind === 'captured-public-sheet',
    observedAt: times.at(-1) ?? null, oldestObservedAt: times[0] ?? null, retrievedAt,
    stations, availableStationCount: stations.length, expectedStationCount: locations.size,
    completeMeasurementStationCount: stations.filter(station => station.quality === 'observed').length,
    missingStationIds: [...locations.keys()].filter(id => !latest.has(id)), rejectedRows,
    aggregation: '각 센서의 제공된 최신 시각 1시간 평균; 서로 다른 관측 시각을 유지',
    timezone: 'Asia/Seoul', timezoneAssumption: '원문에 UTC offset 없음. 서울 현지시각(+09:00)으로 해석하고 원문 시각을 함께 보존함.',
    measurement: 'air-temperature-relative-humidity', pavementObservation: false,
    license: SEOUL_LICENSE, licenseUrl: 'https://www.kogl.or.kr/info/licenseType1.do',
  };
}

let cache = null;
let cacheAt = 0;
let failedAt = 0;

/** Official Sheet sends unquoted keys/trailing commas; normalize syntax without eval. */
export function parseSeoulSheet(text) {
  if (typeof text !== 'string' || text.length > 5_000_000) throw fixedError('SEOUL_INVALID_RESPONSE');
  const json = text
    .replace(/"(?:\\.|[^"\\])*"|([A-Za-z_][A-Za-z0-9_]*)\s*:/g, (token, key) => key ? `${JSON.stringify(key)}:` : token)
    .replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : '');
  let value;
  try { value = JSON.parse(json); } catch { throw fixedError('SEOUL_INVALID_RESPONSE'); }
  if (value.result !== 'ok' || !Array.isArray(value.list) || value.list.length > 1000) throw fixedError('SEOUL_NO_VERIFIED_ROWS');
  return value;
}

/** Official website's public HTTPS Sheet request. No key, login or HTTP downgrade. */
export async function getSeoulWeather(env = defaultEnv()) {
  // Keep the shared Worker/local signature; this public endpoint requires no secret.
  void env;
  if (cache && Date.now() - cacheAt < 5 * 60_000) return cache;
  if (failedAt && Date.now() - failedAt < 60_000) throw fixedError('SEOUL_PUBLIC_SHEET_UNAVAILABLE');
  try {
    const response = await fetch(SEOUL_SHEET_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json, text/plain, */*' },
      body: new URLSearchParams(SEOUL_SHEET_REQUEST).toString() });
    if (!response.ok) throw fixedError('SEOUL_PROVIDER_HTTP_ERROR');
    const body = parseSeoulSheet(await response.text());
    const result = normalizeSeoulRows(body.list, { retrievedAt: new Date().toISOString(), sourceKind: 'public-sheet-observation' });
    if (!result.stations.length) throw fixedError('SEOUL_NO_LOCAL_OBSERVATIONS');
    result.scan = { rowsScanned: body.list.length, totalProviderRows: Number(body.page?.totalCount) || null, partial: true,
      limit: 1000, note: '공식 공개 표의 최근 최대 1,000행 중 확인된 센서만 포함. 전체 센서나 하루 전체 자료를 수집한 결과가 아님.' };
    result.endpoint = SEOUL_SHEET_ENDPOINT;
    result.liveTransportVerified = true;
    result.apiKeyRequired = false;
    cache = result; cacheAt = Date.now(); failedAt = 0;
    return result;
  } catch {
    failedAt = Date.now();
    throw fixedError('SEOUL_PUBLIC_SHEET_UNAVAILABLE');
  }
}
