import regions from '../icing-regions.json' with { type: 'json' };
const root = 'https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/';
const hour = 3_600_000;
const hourKst = 9 * hour;
const day = 24 * hour;
const products = {
  ultra: { endpoint: 'getUltraSrtFcst', temperature: 'T1H', precipitation: 'RN1', maxIssueAge: 3 * hour },
  short: { endpoint: 'getVilageFcst', temperature: 'TMP', precipitation: 'PCP', maxIssueAge: 7 * hour },
};

function timeFromKst(date, time) {
  if (typeof date !== 'string' || typeof time !== 'string' || !/^\d{8}$/.test(date) || !/^\d{4}$/.test(time)) return NaN;
  const local = date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6) + 'T' + time.slice(0, 2) + ':' + time.slice(2);
  const instant = Date.parse(local + ':00+09:00');
  return Number.isFinite(instant) && new Date(instant + hourKst).toISOString().slice(0, 16) === local ? instant : NaN;
}

function requestIssue(kind, instant) {
  const local = instant + hourKst;
  if (kind === 'ultra') return Math.floor((local - 45 * 60_000) / hour) * hour + 30 * 60_000;
  const ready = local - 15 * 60_000;
  const midnight = Math.floor(ready / day) * day;
  return [23, 20, 17, 14, 11, 8, 5, 2].map(h => midnight + h * hour).find(time => time <= ready) ?? midnight - hour;
}

function numeric(text, min, max) {
  if (typeof text !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

function precipitationText(value) {
  if (typeof value !== 'string' || !/^(?:강수없음|\d+(?:\.\d+)?(?:\s*(?:~\s*\d+(?:\.\d+)?)?\s*mm(?:\s*(?:미만|이상))?)?)$/.test(value.trim())) return null;
  return value.trim();
}

export function parseKmaForecast(payload, kind, now = Date.now(), grid = regions.gwanak.kmaGrid) {
  const product = products[kind];
  const response = payload?.response;
  const items = response?.body?.items?.item;
  if (!product || response?.header?.resultCode !== '00' || !Array.isArray(items) || items.length > 1000) return [];
  const issueGroups = new Map();
  for (const item of items) {
    if (item?.nx !== grid.nx || item.ny !== grid.ny) continue;
    if (![product.temperature, product.precipitation, 'PTY', 'REH'].includes(item.category)) continue;
    const issuedAt = timeFromKst(item.baseDate, item.baseTime);
    const time = timeFromKst(item.fcstDate, item.fcstTime);
    if (!Number.isFinite(issuedAt) || issuedAt > now || now - issuedAt > product.maxIssueAge ||
        !Number.isFinite(time) || time < issuedAt || time % hour !== 0 || time + hour <= now || time > now + day) continue;
    if (!issueGroups.has(issuedAt)) issueGroups.set(issuedAt, new Map());
    const hours = issueGroups.get(issuedAt);
    if (!hours.has(time)) hours.set(time, new Map());
    const values = hours.get(time);
    // A conflicting value for the same issue, grid, category and hour is unusable.
    values.set(item.category, values.has(item.category) && values.get(item.category) !== item.fcstValue ? null : item.fcstValue);
  }
  if (!issueGroups.size) return [];
  const issuedAt = Math.max(...issueGroups.keys());
  return [...issueGroups.get(issuedAt)].flatMap(([time, values]) => {
    const temperatureC = numeric(values.get(product.temperature), -70, 60);
    if (temperatureC === null) return [];
    const precipitation = precipitationText(values.get(product.precipitation));
    const precipitationType = numeric(values.get('PTY'), 0, 7);
    const wet = (precipitation !== null && Number.parseFloat(precipitation) > 0 && !precipitation.includes('미만')) ||
      (precipitationType !== null && Number.isInteger(precipitationType) && precipitationType > 0);
    return [{ time, issuedAt, kind, temperatureC, precipitation, wet, humidity: numeric(values.get('REH'), 0, 100) }];
  }).sort((a, b) => a.time - b.time);
}

async function fetchProduct(key, kind, now, grid) {
  const stamp = new Date(requestIssue(kind, now)).toISOString();
  const url = new URL(products[kind].endpoint, root);
  url.search = new URLSearchParams({
    pageNo: '1', numOfRows: '1000', dataType: 'JSON', base_date: stamp.slice(0, 10).replaceAll('-', ''),
    base_time: stamp.slice(11, 16).replace(':', ''), nx: String(grid.nx), ny: String(grid.ny), authKey: key,
  });
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 500_000) return [];
    const text = await response.text();
    return text.length <= 500_000 && !text.includes(key) ? parseKmaForecast(JSON.parse(text), kind, Date.now(), grid) : [];
  } catch {
    return [];
  }
}

const cache = new Map();
const pending = new Map();
// KMA's 5 km Lambert conformal forecast grid (DFS), using its published origin.
export function forecastGrid([lon, lat]) {
  const radians = Math.PI / 180;
  const radius = 6371.00877 / 5;
  const tangent = latitude => Math.tan(Math.PI / 4 + latitude * radians / 2);
  const cone = Math.log(Math.cos(30 * radians) / Math.cos(60 * radians)) /
    Math.log(tangent(60) / tangent(30));
  const scale = radius * Math.cos(30 * radians) * tangent(30) ** cone / cone;
  const origin = scale / tangent(38) ** cone;
  const distance = scale / tangent(lat) ** cone;
  const bearing = (lon - 126) * radians * cone;
  return { nx: Math.round(43 + distance * Math.sin(bearing)), ny: Math.round(136 + origin - distance * Math.cos(bearing)) };
}

export async function getKmaForecast(env, area = 'gwanak', coordinate) {
  const grid = coordinate ? forecastGrid(coordinate) : regions[area].kmaGrid;
  const id = `${grid.nx},${grid.ny}`;
  const now = Date.now();
  const cached = cache.get(id);
  if (cached?.expires > now) return cached.data;
  const key = typeof env?.KMA_API_KEY === 'string' ? env.KMA_API_KEY.trim() : '';
  if (!key) throw new Error('missing-server-key');
  if (!pending.has(id)) {
    pending.set(id, Promise.all([fetchProduct(key, 'ultra', now, grid), fetchProduct(key, 'short', now, grid)]).then(([ultra, short]) => {
      if (!ultra.length && !short.length) throw new Error('no-current-kma-forecasts');
      const data = { source: '기상청 API허브', grid, retrievedAt: Date.now(), ultra, short };
      cache.set(id, { data, expires: Date.now() + (ultra.length && short.length ? 180_000 : 60_000) });
      return data;
    }).finally(() => pending.delete(id)));
  }
  return pending.get(id);
}
