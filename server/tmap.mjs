/** Server-only TMAP adapter. Keys are sent only to the fixed official origin. */
const ORIGIN = 'https://apis.openapi.sk.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 3_000_000;

export class TmapError extends Error {
  constructor(message, status = 502, code = 'TMAP_UPSTREAM_ERROR') {
    super(message);
    this.name = 'TmapError';
    this.status = status;
    this.code = code;
  }
}

function appKey(env) {
  const key = env.TMAP_APP_KEY?.trim();
  if (!key) throw new TmapError('TMAP 연동 키가 설정되지 않았어요. 서버의 TMAP_APP_KEY 설정이 필요합니다.', 503, 'TMAP_NOT_CONFIGURED');
  return key;
}

function errorForStatus(status, providerCode) {
  if ((status === 401 || status === 403) && providerCode === 'INVALID_API_KEY') return new TmapError('TMAP에서 현재 앱 키를 유효하지 않은 키로 판정했어요. TMAP 개발자센터에서 발급된 앱 키와 서버 설정을 확인해야 합니다.', 502, 'TMAP_ACCESS_DENIED');
  if (status === 401 || status === 403) return new TmapError('TMAP에서 요청을 허용하지 않았어요. 앱 키와 해당 API 상품의 이용 권한을 확인해야 합니다.', 502, 'TMAP_ACCESS_DENIED');
  if (status === 429) return new TmapError('TMAP 호출 한도에 도달했어요. 잠시 후 다시 시도하거나 상품의 사용량을 확인해 주세요.', 429, 'TMAP_QUOTA_EXCEEDED');
  if (status === 404) return new TmapError('요청한 위치의 TMAP 결과를 찾지 못했어요. 장소를 다시 선택해 주세요.', 422, 'TMAP_RESULT_NOT_FOUND');
  if (status === 400 || status === 422) return new TmapError('TMAP이 검색 조건을 처리하지 못했어요. 출발지와 목적지를 다시 선택해 주세요.', 422, 'TMAP_INVALID_REQUEST');
  return new TmapError('TMAP 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.', 502, 'TMAP_UPSTREAM_ERROR');
}

async function callTmap(path, options = {}, env = globalThis.process?.env ?? {}) {
  const key = appKey(env);
  // path is constructed by this module, never accepted from an HTTP client.
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/tmap/')) throw new TmapError('지원하지 않는 TMAP 요청입니다.', 400, 'TMAP_INVALID_REQUEST');
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', appKey: key, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new TmapError('TMAP 응답 시간이 초과됐어요. 다시 시도해 주세요.', 504, 'TMAP_TIMEOUT');
    throw new TmapError('TMAP 서버에 연결하지 못했어요. 네트워크 상태를 확인하고 다시 시도해 주세요.', 502, 'TMAP_NETWORK_ERROR');
  }
  if (!response.ok) {
    // Retain only a short, structured provider code; never expose its body or key.
    let providerCode;
    const errorReader = response.body?.getReader();
    if (errorReader) {
      const errorDecoder = new TextDecoder();
      let errorText = ''; let errorBytes = 0;
      try {
        while (true) {
          const { value, done } = await errorReader.read();
          if (done) break;
          errorBytes += value.byteLength;
          if (errorBytes > 16_384) { await errorReader.cancel(); break; }
          errorText += errorDecoder.decode(value, { stream: true });
        }
        if (errorBytes <= 16_384) {
          const errorBody = JSON.parse(errorText + errorDecoder.decode());
          const candidate = errorBody?.error?.code ?? errorBody?.error?.id ?? errorBody?.code;
          if (/^[A-Z0-9_.:-]{1,80}$/i.test(String(candidate ?? ''))) providerCode = String(candidate);
        }
      } catch { /* Upstream diagnostics must not replace the safe error. */ }
      finally { errorReader.releaseLock(); }
    }
    const failure = errorForStatus(response.status, providerCode);
    failure.upstreamStatus = response.status;
    if (providerCode) failure.providerCode = providerCode;
    throw failure;
  }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new TmapError('TMAP 응답이 처리 가능한 크기를 초과했어요.', 502, 'TMAP_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TmapError('TMAP이 빈 응답을 반환했어요.', 502, 'TMAP_INVALID_RESPONSE');
  const chunks = [];
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new TmapError('TMAP 응답이 처리 가능한 크기를 초과했어요.', 502, 'TMAP_RESPONSE_TOO_LARGE'); }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    const body = JSON.parse(chunks.join('') + decoder.decode());
    if (!body || typeof body !== 'object' || body.error) throw new TmapError('TMAP이 정상적인 검색 결과를 반환하지 않았어요. API 권한 또는 검색 조건을 확인해 주세요.', 502, 'TMAP_INVALID_RESPONSE');
    return body;
  } catch (error) {
    if (error instanceof TmapError) throw error;
    throw new TmapError('TMAP 응답 형식을 읽지 못했어요. 잠시 후 다시 시도해 주세요.', 502, 'TMAP_INVALID_RESPONSE');
  } finally { reader.releaseLock(); }
}

const safeText = (value, limit = 300) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const numeric = value => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const validKoreanCoordinate = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= 32 && lat <= 39.5 && lon >= 124 && lon <= 132;

function placeFromPoi(poi) {
  const point = [
    { coordinateType: 'pedestrian-entrance', lat: numeric(poi?.pnsLat), lon: numeric(poi?.pnsLon) },
    { coordinateType: 'entrance', lat: numeric(poi?.frontLat), lon: numeric(poi?.frontLon) },
    { coordinateType: 'center', lat: numeric(poi?.noorLat), lon: numeric(poi?.noorLon) },
  ].find(item => validKoreanCoordinate(item.lat, item.lon));
  const name = safeText(poi?.name, 150);
  const id = safeText(String(poi?.id ?? ''), 80);
  if (!id || !name || !point) return null;
  const newAddresses = poi.newAddressList?.newAddress;
  const roadAddress = Array.isArray(newAddresses) ? safeText(newAddresses.find(address => address?.fullAddressRoad)?.fullAddressRoad) : '';
  const address = roadAddress || [poi.upperAddrName, poi.middleAddrName, poi.lowerAddrName, poi.detailAddrName,
    [safeText(poi.firstNo), safeText(poi.secondNo)].filter(value => value && value !== '0').join('-'),
  ].map(value => safeText(value)).filter(Boolean).join(' ');
  return { id, name, address, ...point };
}

export async function searchTmapPlaces(query, env = globalThis.process?.env ?? {}) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 80) throw new TmapError('검색어를 2자 이상 80자 이하로 입력해 주세요.', 400, 'TMAP_INVALID_QUERY');
  const params = new URLSearchParams({ version: '1', searchKeyword: query.trim(), searchtypCd: 'A', reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO', count: '15', page: '1', multiPoint: 'Y' });
  const payload = await callTmap(`/tmap/pois?${params}`, {}, env);
  const result = payload.searchPoiInfo;
  if (!result || typeof result !== 'object') throw new TmapError('TMAP 장소 검색 응답을 확인할 수 없어요.', 502, 'TMAP_INVALID_RESPONSE');
  const raw = result.pois?.poi;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const places = list.map(placeFromPoi).filter(Boolean);
  if (list.length && !places.length) throw new TmapError('검색 결과에 사용할 수 있는 위치 좌표가 없어요. 다른 장소를 검색해 주세요.', 502, 'TMAP_INVALID_COORDINATES');
  return { places, source: 'TMAP 장소 검색 API', retrievedAt: new Date().toISOString(), totalCount: numeric(result.totalCount) ?? places.length };
}

function validateEndpoint(endpoint, label) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.lat !== 'number' || typeof endpoint.lon !== 'number'
      || !validKoreanCoordinate(endpoint.lat, endpoint.lon) || !safeText(endpoint.name, 150)) {
    throw new TmapError(`${label}를 검색 결과에서 선택해 주세요.`, 400, 'TMAP_INVALID_ENDPOINT');
  }
  return { lat: endpoint.lat, lon: endpoint.lon, name: safeText(endpoint.name, 150) };
}

export async function getTmapRoute(request, env = globalThis.process?.env ?? {}) {
  const start = validateEndpoint(request?.start, '출발지');
  const end = validateEndpoint(request?.end, '목적지');
  if (typeof request?.avoidStairs !== 'boolean') throw new TmapError('계단 제외 여부를 확인해 주세요.', 400, 'TMAP_INVALID_OPTION');
  if (Math.abs(start.lat - end.lat) < 0.000001 && Math.abs(start.lon - end.lon) < 0.000001) throw new TmapError('출발지와 목적지가 같아요. 서로 다른 장소를 선택해 주세요.', 400, 'TMAP_SAME_ENDPOINT');
  const searchOption = request.avoidStairs ? '30' : '10';
  const payload = await callTmap('/tmap/routes/pedestrian?version=1', {
    method: 'POST',
    body: JSON.stringify({ startX: start.lon, startY: start.lat, endX: end.lon, endY: end.lat,
      startName: encodeURIComponent(start.name), endName: encodeURIComponent(end.name),
      reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO', searchOption, sort: 'index' }),
  }, env);
  if (!Array.isArray(payload.features) || !payload.features.length) throw new TmapError('TMAP에서 이 두 장소를 잇는 보행 경로를 찾지 못했어요.', 422, 'TMAP_ROUTE_NOT_FOUND');
  const summary = payload.features.find(feature => numeric(feature?.properties?.totalDistance) !== null && numeric(feature?.properties?.totalTime) !== null)?.properties;
  const distanceMeters = numeric(summary?.totalDistance);
  const durationSeconds = numeric(summary?.totalTime);
  if (distanceMeters === null || durationSeconds === null || distanceMeters <= 0 || durationSeconds <= 0) throw new TmapError('TMAP 응답에 유효한 경로 거리·소요시간이 없어요.', 502, 'TMAP_INVALID_RESPONSE');
  const steps = payload.features.filter(feature => feature?.geometry?.type === 'Point' && safeText(feature?.properties?.description, 1000))
    .map((feature, index) => ({ index: index + 1, instruction: safeText(feature.properties.description, 1000), name: safeText(feature.properties.name, 150),
      distanceMeters: numeric(feature.properties.distance), durationSeconds: numeric(feature.properties.time) }));
  return {
    source: 'TMAP 보행자 경로 API', retrievedAt: new Date().toISOString(),
    distanceMeters, durationSeconds, steps: steps.slice(0, 500), stepsTruncated: steps.length > 500,
    searchOption, optionLabel: request.avoidStairs ? '최단거리 + 계단 제외' : '최단거리',
    startName: start.name, endName: end.name, avoidsIce: false,
    notice: 'TMAP의 일반 보행 경로입니다. 결빙 회피 결과가 아니며 휠체어·보행약자에게 적합한 경로임을 보장하지 않습니다.',
  };
}
