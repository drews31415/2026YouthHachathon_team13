import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Check, ChevronDown, Clock3, Footprints, Info, MapPin, Search, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import './TmapPlanner.css';

interface TmapPlace { id: string; name: string; address: string; lat: number; lon: number; coordinateType: 'pedestrian-entrance' | 'entrance' | 'center'; }
const coordinateLabels = { 'pedestrian-entrance': '보행자 출입구 좌표', entrance: '시설 입구 좌표 · 보행자 전용 여부 미확인', center: '장소 중심 좌표 · 입구 위치 미확인' };
interface TmapStep { index: number; instruction: string; name: string; distanceMeters: number | null; durationSeconds: number | null; }
interface TmapRoute {
  source: string; retrievedAt: string; distanceMeters: number; durationSeconds: number; steps: TmapStep[];
  stepsTruncated?: boolean; optionLabel: string; startName: string; endName: string; avoidsIce: false;
}
interface RouteState { normal: TmapRoute | null; stairs: TmapRoute | null; normalError: string; stairsError: string; }
const EMPTY_ROUTES: RouteState = { normal: null, stairs: null, normalError: '', stairsError: '' };
// Keep transient results below the provider's 24-hour usage limit.
const TTL_MS = 23 * 60 * 60 * 1000;
const meters = (value: number) => value < 1000 ? `${Math.round(value)}m` : `${(value / 1000).toFixed(2)}km`;
const seconds = (value: number) => { const total = Math.round(Math.abs(value)); return `${Math.floor(total / 60)}분 ${total % 60}초`; };
const kstTime = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

async function readResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) {
    const failure = body as { error?: unknown; message?: unknown };
    const message = typeof failure.error === 'string' ? failure.error : typeof failure.message === 'string' ? failure.message : 'TMAP 요청을 처리하지 못했어요.';
    throw new Error(message.slice(0, 400));
  }
  return body as T;
}

function PlaceSearch({ label, selected, onSelect, onEdit }: { label: string; selected: TmapPlace | null; onSelect: (place: TmapPlace) => void; onEdit: () => void; }) {
  const inputId = useId();
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<TmapPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const serial = useRef(0);
  useEffect(() => () => controller.current?.abort(), []);

  async function search() {
    if (busy.current) return;
    const trimmed = query.trim();
    if (trimmed.length < 2 || trimmed.length > 80) { setError('검색어를 2자 이상 80자 이하로 입력해 주세요.'); return; }
    controller.current?.abort();
    const current = ++serial.current;
    const abort = new AbortController(); controller.current = abort;
    busy.current = true;
    setLoading(true); setError(''); setPlaces([]); setSearched(false); onEdit();
    try {
      const data = await readResponse<{ places: TmapPlace[]; source: string }>(await fetch(`/api/tmap/places?q=${encodeURIComponent(trimmed)}`, { cache: 'no-store', signal: abort.signal }));
      if (serial.current !== current) return;
      if (!Array.isArray(data.places)) throw new Error('TMAP 장소 응답 형식이 올바르지 않아요.');
      setPlaces(data.places.filter(place => typeof place.id === 'string' && typeof place.name === 'string' && Number.isFinite(place.lat) && Number.isFinite(place.lon)).slice(0, 15));
      setSearched(true);
    } catch (failure) { if (serial.current === current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : '장소를 검색하지 못했어요.'); }
    finally { if (serial.current === current) { busy.current = false; setLoading(false); } }
  }

  return <div className="tmap-place-search">
    <label htmlFor={inputId}>{label}</label>
    <div className="tmap-search-row"><Search size={17} aria-hidden="true" /><input id={inputId} value={query} placeholder={`${label} 이름이나 주소`} maxLength={80} autoComplete="off" onChange={event => {
      serial.current += 1; controller.current?.abort(); busy.current = false; setLoading(false); setQuery(event.target.value); setPlaces([]); setSearched(false); setError(''); onEdit();
    }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} /><button type="button" onClick={() => void search()} disabled={loading}>{loading ? '조회 중' : '검색'}</button></div>
    {selected && <div className="tmap-selected-place"><MapPin size={16} /><div><strong>{selected.name}</strong><span>{selected.address || '주소 정보 없음'}</span><small>{coordinateLabels[selected.coordinateType]}</small></div><Check size={16} /></div>}
    {error && <p className="tmap-error" role="alert"><TriangleAlert size={15} />{error}</p>}
    {!selected && places.length > 0 && <ul className="tmap-place-results" aria-label={`${label} 검색 결과`}>{places.map((place, index) => <li key={`${place.id}-${index}`}><button type="button" onClick={() => { onSelect(place); setQuery(place.name); setPlaces([]); }}><MapPin size={16} /><span><strong>{place.name}</strong><small>{place.address || '주소 정보 없음'}</small></span><ArrowRight size={15} /></button></li>)}</ul>}
    {!selected && searched && !places.length && !error && <p className="tmap-empty">검색 결과가 없어요. 도로명이나 다른 장소 이름으로 검색해 주세요.</p>}
  </div>;
}

export default function TmapPlanner() {
  const [start, setStart] = useState<TmapPlace | null>(null);
  const [end, setEnd] = useState<TmapPlace | null>(null);
  const [avoidStairs, setAvoidStairs] = useState(true);
  const [routes, setRoutes] = useState<RouteState>(EMPTY_ROUTES);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSteps, setShowSteps] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const controllers = useRef<AbortController[]>([]);
  const busy = useRef(false);
  const serial = useRef(0);
  const sessionStart = useRef(Date.now());
  const route = avoidStairs ? routes.stairs ?? routes.normal : routes.normal;
  const both = routes.normal && routes.stairs;
  const difference = both ? routes.stairs!.durationSeconds - routes.normal!.durationSeconds : null;
  const distanceDifference = both ? routes.stairs!.distanceMeters - routes.normal!.distanceMeters : null;

  function invalidate() {
    ++serial.current; controllers.current.forEach(controller => controller.abort()); controllers.current = [];
    busy.current = false;
    setRoutes(EMPTY_ROUTES); setLoading(false); setError(''); setShowSteps(false);
  }
  useEffect(() => {
    const expireResults = () => {
      if (Date.now() - sessionStart.current >= TTL_MS) {
        invalidate(); setStart(null); setEnd(null); setEpoch(value => value + 1); sessionStart.current = Date.now();
        setError('조회 자료의 사용시간이 지나 삭제했어요. 장소와 경로를 새로 조회해 주세요.');
      }
    };
    const expiry = window.setInterval(expireResults, 15_000);
    window.addEventListener('focus', expireResults);
    document.addEventListener('visibilitychange', expireResults);
    return () => { clearInterval(expiry); window.removeEventListener('focus', expireResults); document.removeEventListener('visibilitychange', expireResults); controllers.current.forEach(controller => controller.abort()); };
  }, []);

  async function fetchRoute(stairs: boolean, signal: AbortSignal) {
    const body = { start: { lat: start!.lat, lon: start!.lon, name: start!.name }, end: { lat: end!.lat, lon: end!.lon, name: end!.name }, avoidStairs: stairs };
    const data = await readResponse<TmapRoute>(await fetch('/api/tmap/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal }));
    if (!Number.isFinite(data.distanceMeters) || data.distanceMeters <= 0 || !Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0 || !Array.isArray(data.steps)) throw new Error('TMAP의 경로 거리·시간을 확인하지 못했어요.');
    return data;
  }

  async function calculate() {
    if (busy.current) return;
    if (!start || !end) { setError('출발지와 목적지를 각각 검색한 뒤 결과에서 선택해 주세요.'); return; }
    if (start.lat === end.lat && start.lon === end.lon) { setError('출발지와 목적지가 같아요. 서로 다른 장소를 선택해 주세요.'); return; }
    invalidate(); const current = ++serial.current; busy.current = true; setLoading(true);
    const normalController = new AbortController(); const stairsController = new AbortController();
    controllers.current = [normalController, stairsController];
    const requests = [fetchRoute(false, normalController.signal)];
    if (avoidStairs) requests.push(fetchRoute(true, stairsController.signal));
    const results = await Promise.allSettled(requests);
    if (serial.current !== current) return;
    const message = (failure: unknown) => failure instanceof Error ? failure.message : '경로를 조회하지 못했어요.';
    const normalResult = results[0]; const stairsResult = results[1];
    setRoutes({
      normal: normalResult.status === 'fulfilled' ? normalResult.value : null,
      stairs: stairsResult?.status === 'fulfilled' ? stairsResult.value : null,
      normalError: normalResult.status === 'rejected' ? message(normalResult.reason) : '',
      stairsError: stairsResult?.status === 'rejected' ? message(stairsResult.reason) : '',
    });
    busy.current = false; setLoading(false);
  }

  return <section className="tmap-planner" aria-labelledby="tmap-heading">
    <div className="tmap-heading-row"><h2 id="tmap-heading">TMAP 보행 경로</h2></div>
    <p className="tmap-intro">국내 장소를 검색하고 실제 보행 경로의 거리와 안내를 확인하세요. 결빙 위험을 반영한 경로는 아닙니다.</p>
    <div className="tmap-transmission-note"><Info size={16} /><p>검색을 누르면 검색어가, 경로 조회를 누르면 선택한 두 장소의 이름·좌표가 TMAP으로 전송됩니다. 검색 결과와 경로는 이 화면에서만 사용하며 영구 저장하지 않습니다.</p></div>
    <div className="tmap-search-fields" key={epoch}>
      <PlaceSearch label="출발지" selected={start} onEdit={() => { setStart(null); invalidate(); }} onSelect={place => { setStart(place); invalidate(); }} />
      <span className="tmap-fields-arrow"><ArrowDown size={16} /></span>
      <PlaceSearch label="목적지" selected={end} onEdit={() => { setEnd(null); invalidate(); }} onSelect={place => { setEnd(place); invalidate(); }} />
    </div>
    <label className="tmap-option"><input type="checkbox" checked={avoidStairs} onChange={event => { setAvoidStairs(event.target.checked); invalidate(); }} /><span><strong>계단 제외 경로도 비교</strong><small>TMAP 최단거리와 계단 제외 옵션을 각각 조회합니다.</small></span></label>
    <button type="button" className="tmap-route-button" onClick={() => void calculate()} disabled={loading}><Footprints size={19} />{loading ? 'TMAP에서 경로를 조회하고 있어요…' : 'TMAP 경로 조회'}{!loading && <ArrowRight size={18} />}</button>
    {error && <p className="tmap-error" role="alert"><TriangleAlert size={16} />{error}</p>}
    {(routes.normalError || routes.stairsError) && <div className="tmap-route-errors" role="alert">{routes.normalError && <p><strong>최단거리 조회 실패</strong>{routes.normalError}</p>}{routes.stairsError && <p><strong>계단 제외 조회 실패</strong>{routes.stairsError}</p>}{avoidStairs && !both && route && <small>한쪽 경로만 확인되어 추가시간·거리 차이는 계산하지 않습니다.</small>}</div>}
    {route && <div className="tmap-route-result" aria-live="polite">
      <div className="tmap-route-title"><strong>{route.startName}</strong><ArrowRight size={15} /><strong>{route.endName}</strong></div>
      <div className="tmap-comparison-cards">{routes.normal && <div className={`tmap-route-card ${!routes.stairs ? 'chosen' : ''}`}><span><Footprints size={16} />최단거리</span><strong>{Math.ceil(routes.normal.durationSeconds / 60)}<small>분</small></strong><p>{meters(routes.normal.distanceMeters)} · {seconds(routes.normal.durationSeconds)}</p></div>}{routes.stairs && <div className="tmap-route-card chosen"><span><ShieldCheck size={16} />계단 제외</span><strong>{Math.ceil(routes.stairs.durationSeconds / 60)}<small>분</small></strong><p>{meters(routes.stairs.distanceMeters)} · {seconds(routes.stairs.durationSeconds)}</p></div>}</div>
      {difference !== null && distanceDifference !== null && <div className="tmap-difference"><Clock3 size={17} /><p><strong>계단 제외 시 {difference > 0 ? `${seconds(difference)} 더 걸려요` : difference < 0 ? `${seconds(difference)} 짧게 조회됐어요` : '소요시간이 같아요'}.</strong><span>거리 {distanceDifference > 0 ? `${meters(distanceDifference)} 증가` : distanceDifference < 0 ? `${meters(Math.abs(distanceDifference))} 감소` : '동일'} · 결빙 회피 추가시간이 아닙니다.</span></p></div>}
      <button type="button" className="tmap-steps-toggle" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}><span>{route === routes.stairs ? '계단 제외 경로' : '최단거리 경로'} 안내 문구 {showSteps ? '접기' : '보기'}</span><ChevronDown size={17} /></button>
      {showSteps && <>{route.steps.length ? <ol className="tmap-route-steps">{route.steps.map(step => <li key={step.index}><span>{step.index}</span><div><p>{step.instruction}</p>{step.distanceMeters !== null && <small>{meters(step.distanceMeters)}</small>}</div></li>)}</ol> : <p className="tmap-empty">이 응답에는 상세 안내 문구가 없습니다.</p>}{route.stepsTruncated && <p className="tmap-empty">안내가 많아 앞 500개 구간만 표시합니다.</p>}</>}
      <div className="tmap-result-footer"><span>{route.source} · {kstTime(route.retrievedAt)} KST</span><button type="button" onClick={invalidate}><X size={13} />결과 닫기</button></div>
    </div>}
    <p className="tmap-accessibility-note">계단 제외 옵션만으로 휠체어·보행약자 통행 적합성을 보장하지 않습니다. 노면 결빙, 보도 폭, 턱, 공사 여부는 이 결과로 확인할 수 없어요.</p>
  </section>;
}
