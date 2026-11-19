// Provider observations remain point measurements. They never create street icing labels.
import stationMetadata from './kma-stations.json' with { type: 'json' };

export const KMA_SOURCE = '기상청 AWS 매분 관측';
export const KMA_ENDPOINT = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min';
export const KMA_PUBLIC_REQUEST = `${KMA_ENDPOINT}?disp=1&help=1&stn=0`;
export const KMA_MAX_AGE_MS = 30 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const units = Object.freeze({ temperature: '°C', humidity: '%', dewPoint: '°C', rain15mMm: 'mm/15min', rain60mMm: 'mm/60min', rain12hMm: 'mm/12h', rainDayMm: 'mm/KST calendar day', windSpeedMps: 'm/s', windDirectionDegrees: 'degree', stationPressureHpa: 'hPa', seaLevelPressureHpa: 'hPa' });

export class KmaDataError extends Error {
  constructor(code) { super(`기상청 관측자료를 사용할 수 없습니다 (${code}).`); this.name = 'KmaDataError'; this.code = code; }
}

export function kmaAwsQueryMinute(now = Date.now()) {
  // Use a recent completed minute to avoid waiting on the newest collection.
  return new Date(now + 9 * 3_600_000 - 5 * 60_000).toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

function timeFromKst(raw) {
  if (!/^\d{12}$/.test(raw)) return null;
  const iso = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}T${raw.slice(8,10)}:${raw.slice(10,12)}:00+09:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms + 9 * 3600000).toISOString().replace(/[-:T]/g, '').slice(0,12) !== raw) return null;
  return ms;
}

function observation(value, min, max) {
  if (!/^-?\d+(?:\.\d+)?$/.test(value ?? '')) return null;
  const number = Number(value);
  // Official help=1: values <= -50 are missing/error. Other out-of-domain values are unknown too.
  return number <= -50 || number < min || number > max ? null : number;
}

export function parseKmaAws(raw, { retrievedAt, now = Date.now(), retrievalMode = 'live', sha256 = null } = {}) {
  const retrievedMs = Date.parse(retrievedAt);
  if (!Number.isFinite(now) || !Number.isFinite(retrievedMs) || retrievedMs > now + FUTURE_TOLERANCE_MS) throw new KmaDataError('invalid-retrieval-time');
  if (typeof raw !== 'string' || !raw.startsWith('#START7777') || !raw.includes('#7777END') || !/#\s+KST\s+ID\s+deg\s+m\/s/.test(raw) || !/# YYMMDDHHMI\s+STN\s+WD1\s+WS1\s+WDS\s+WSS\s+WD10\s+WS10\s+TA\s+RE\s+RN-15m\s+RN-60m\s+RN-12H\s+RN-DAY\s+HM\s+PA\s+PS\s+TD/.test(raw)) throw new KmaDataError('unknown-response-format');
  const metadataById = new Map(stationMetadata.stations.map(station => [station.id, station]));
  const latest = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!/^\d{12},/.test(line)) continue;
    const cells = line.trim().split(',');
    if (cells.at(-1) === '=') cells.pop();
    if (cells.length !== 18 || !/^\d+$/.test(cells[1])) throw new KmaDataError('invalid-row');
    const id = Number(cells[1]);
    if (!metadataById.has(id)) continue;
    const observedMs = timeFromKst(cells[0]);
    if (observedMs === null || observedMs > retrievedMs + FUTURE_TOLERANCE_MS || observedMs > now + FUTURE_TOLERANCE_MS) throw new KmaDataError('invalid-observation-time');
    if ((latest.get(id)?.observedMs ?? -Infinity) >= observedMs) continue;
    const metadata = metadataById.get(id);
    const values = {
      temperature: observation(cells[8], -49.9, 60),
      humidity: observation(cells[14], 0, 100),
      rainDetected: cells[9] === '0.0' || cells[9] === '0' ? false : cells[9] === '1.0' || cells[9] === '1' ? true : null,
      rain15mMm: observation(cells[10], 0, 2000),
      rain60mMm: observation(cells[11], 0, 2000),
      rain12hMm: observation(cells[12], 0, 3000),
      rainDayMm: observation(cells[13], 0, 3000),
      windSpeedMps: observation(cells[3], 0, 150),
      windDirectionDegrees: observation(cells[2], 0, 360),
      stationPressureHpa: observation(cells[15], 500, 1100),
      seaLevelPressureHpa: observation(cells[16], 800, 1100),
      dewPoint: observation(cells[17], -49.9, 60),
    };
    const { retrievedAt: metadataRetrievedAt, ...location } = metadata;
    latest.set(id, { ...location, metadataRetrievedAt, ...values, observedMs, observedAt: new Date(observedMs).toISOString(), missingFields: Object.entries(values).filter(([,value]) => value === null).map(([field]) => field) });
  }
  const stations = stationMetadata.stations.map(({id}) => latest.get(id)).filter(station => station && now - station.observedMs < KMA_MAX_AGE_MS && (station.temperature !== null || station.humidity !== null || station.rain60mMm !== null));
  if (stations.length === 0) throw new KmaDataError('no-fresh-local-observations');
  const observedMs = Math.max(...stations.map(station => station.observedMs));
  const expiresMs = Math.min(...stations.map(station => station.observedMs + KMA_MAX_AGE_MS));
  return {
    source: KMA_SOURCE, sourceUrl: 'https://apihub.kma.go.kr/apiList.do?seqApi=2&seqApiSub=239', endpoint: KMA_PUBLIC_REQUEST,
    observedAt: new Date(observedMs).toISOString(), retrievedAt: new Date(retrievedMs).toISOString(), expiresAt: new Date(expiresMs).toISOString(), retrievalMode,
    units, sha256, stationMetadataSource: stationMetadata.sourceUrl,
    stations: stations.map(({observedMs: _observedMs, ...station}) => station),
    missingStationIds: stationMetadata.stations.map(({id}) => id).filter(id => !stations.some(station => station.id === id)),
    quality: '실시간 AWS 값의 제공자 결측·오류 표식을 적용했습니다. 최종 품질검사가 끝난 확정 통계가 아닙니다.',
    limitations: ['관측소의 대기 관측값이며 골목 노면 온도·결빙 관측이 아닙니다.', '강수감지 결측은 무강수로 바꾸지 않습니다.', '강수량은 표시된 시간 구간 누적값이며 일 누적은 한국시간 0시부터입니다.', '관측시각으로부터 30분이 지나면 표시하지 않습니다.'],
  };
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function parseKmaCapture(capture, now = Date.now()) {
  if (!capture || capture.source !== KMA_SOURCE || capture.endpoint !== KMA_PUBLIC_REQUEST || typeof capture.rawText !== 'string' || !/^[0-9a-f]{64}$/.test(capture.sha256 ?? '') || await sha256Hex(capture.rawText) !== capture.sha256) throw new KmaDataError('invalid-captured-source');
  // Validate both at the true acquisition time and at display time. Never relabel acquisition as now.
  parseKmaAws(capture.rawText, { retrievedAt: capture.retrievedAt, now: Date.parse(capture.retrievedAt) });
  return parseKmaAws(capture.rawText, { retrievedAt: capture.retrievedAt, now, retrievalMode: 'captured', sha256: capture.sha256 });
}
