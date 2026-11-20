import { getKmaRainHistory, getKmaWeather } from './kma.mjs';
import { getKmaForecast } from './kma-forecast.mjs';
import { getKmaGrid } from './kma-grid.mjs';
import icingRegions from '../icing-regions.json' with { type: 'json' };
import { getSeoulWeather } from './seoul.mjs';
import { getSeoulRainHistory } from './seoul-rain.mjs';
import { searchTmapPlaces, getTmapRoute } from './tmap.mjs';

const pending = new Map();
const services = { kma: getKmaWeather, seoul: getSeoulWeather };
const publicMessages = {
  kma: '기상청 관측을 조회하지 못했습니다.',
  seoul: '서울시 최신 관측을 조회하지 못했습니다.',
  tmap: 'TMAP 서비스에 연결하지 못했습니다.',
};

async function weather(provider, env) {
  if (!pending.has(provider)) {
    pending.set(provider, services[provider](env).finally(() => pending.delete(provider)));
  }
  return pending.get(provider);
}

const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

function seoulPoint(params) {
  const lon = Number(params.get('lon')), lat = Number(params.get('lat'));
  return lon >= 126.73 && lon <= 127.20 && lat >= 37.39 && lat <= 37.72
    ? [Number(lon.toFixed(4)), Number(lat.toFixed(4))] : null;
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const provider = url.pathname.split('/')[2];
  try {
    if (url.pathname === '/api/kma/forecast' || url.pathname === '/api/kma/grid') {
      if (request.method !== 'GET') return json({ error: '조회 요청만 지원합니다.' }, 405);
      const load = url.pathname.endsWith('/forecast') ? getKmaForecast : getKmaGrid;
      if (url.searchParams.has('lon') || url.searchParams.has('lat')) {
        const point = seoulPoint(url.searchParams);
        if (!point) return json({ error: '서울 예보의 조회 범위를 벗어났습니다.' }, 400);
        return json(await load(env, undefined, point));
      }
      const area = url.searchParams.get('area') ?? 'gwanak';
      if (!Object.hasOwn(icingRegions, area)) return json({ error: '지원하지 않는 지역입니다.' }, 400);
      return json(await load(env, area));
    }
    if (url.pathname === '/api/kma/weather' || url.pathname === '/api/seoul/weather') {
      if (request.method !== 'GET') return json({ error: '조회 요청만 지원합니다.' }, 405);
      return json(await weather(provider, env));
    }
    if (url.pathname === '/api/kma/rain-history') {
      if (request.method !== 'GET') return json({ error: '조회 요청만 지원합니다.' }, 405);
      return json(await getKmaRainHistory(env));
    }
    if (url.pathname === '/api/seoul/rain-history') {
      if (request.method !== 'GET') return json({ error: '조회 요청만 지원합니다.' }, 405);
      return json(await getSeoulRainHistory());
    }
    if (url.pathname === '/api/tmap/places' && request.method === 'GET') {
      return json(await searchTmapPlaces(url.searchParams.get('q') ?? '', env));
    }
    if (url.pathname === '/api/tmap/route' && request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: '앱에서 다시 조회해 주세요.' }, 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: '요청 형식을 확인해 주세요.' }, 415);
      if (Number(request.headers.get('content-length')) > 8192) return json({ error: '요청이 너무 큽니다.' }, 413);
      const reader = request.body?.getReader();
      if (!reader) return json({ error: '출발지와 목적지를 확인해 주세요.' }, 400);
      const decoder = new TextDecoder();
      let body = '', bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 8192) { await reader.cancel(); return json({ error: '요청이 너무 큽니다.' }, 413); }
        body += decoder.decode(part.value, { stream: true });
      }
      let input;
      try { input = JSON.parse(body + decoder.decode()); } catch { return json({ error: '출발지와 목적지를 확인해 주세요.' }, 400); }
      return json(await getTmapRoute(input, env));
    }
    return json({ error: '지원하지 않는 조회입니다.' }, 404);
  } catch (error) {
    if (provider === 'tmap' && /^TMAP_[A-Z_]+$/.test(error?.code) && Number.isInteger(error.status)) {
      return json({ code: error.code, error: error.message }, error.status);
    }
    if ((url.pathname === '/api/kma/weather' || url.pathname === '/api/kma/rain-history') && error?.name === 'KmaDataError' && /^[a-z;-]+$/.test(error.code)) {
      return json({ error: publicMessages.kma, code: error.code }, 503);
    }
    const message = url.pathname === '/api/kma/forecast' ? '기상청 예보를 조회하지 못했습니다.' : publicMessages[provider];
    return json({ error: message ?? '자료 조회에 실패했습니다.' }, 503);
  }
}
