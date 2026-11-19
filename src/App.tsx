import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpDown, ChevronLeft, ChevronRight, Clock3, Footprints, Map, MapPin, Navigation, RefreshCw, Settings2, Snowflake, Volume2, X } from 'lucide-react';
import { analyzeRisk, findForecastDetour, nearestPlace, searchRoutes } from './core/engine';
import type { Coordinate, Network, Place, Route, SearchOptions, SearchResult } from './core/types';
import { fetchNetwork } from './services/network';
import type { IcingArea } from './services/icing-weather';
import icingRegions from '../icing-regions.json';
import { gangnamDemoPlaces } from './gangnam-pilot';
import { PlaceInput } from './components/PlaceInput';
import { WalkingMap } from './components/WalkingMap';
import { useIcingForecast } from './components/IcingForecastControl';
import { WalkingRouteResult } from './components/WalkingRouteResult';
import Observations from './components/Observations';
import TmapPlanner from './components/TmapPlanner';
import './walking-flow.css';

const defaults: SearchOptions = { origin: null, destination: null, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null };
const distance = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
const stamp = (s: string) => new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

function duration(seconds: number) {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}초` : `${Math.floor(rounded / 60)}분 ${rounded % 60}초`;
}

export default function App() {
  const [area] = useState<IcingArea>(() => new URLSearchParams(window.location.search).get('area') === 'gangnam' ? 'gangnam' : 'gwanak');
  const areaLabel = icingRegions[area].label;
  const [startDemo] = useState(() => area === 'gangnam' && new URLSearchParams(window.location.search).get('demo') === '1');
  const [view, setView] = useState<'map' | 'weather' | 'tmap'>('map');
  const [page, setPage] = useState<'home' | 'search'>(startDemo ? 'search' : 'home');
  const [network, setNetwork] = useState<Network | null>(null);
  const [dataError, setDataError] = useState('');
  const [reload, setReload] = useState(0);
  const [options, setOptions] = useState<SearchOptions>(defaults);
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [message, setMessage] = useState('');
  const [locating, setLocating] = useState(false);
  const [info, setInfo] = useState(false);
  const [largeText, setLargeText] = useState(() => { try { return localStorage.getItem('bbzr-large-text') === 'true'; } catch { return false; } });
  const [selectionMode, setSelectionMode] = useState<'origin' | 'destination' | null>(null);
  const [navigation, setNavigation] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [recenterKey, setRecenterKey] = useState(0);
  const [showForecast, setShowForecast] = useState(startDemo);
  const [selectedRoute, setSelectedRoute] = useState<Route['type'] | null>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const mapSection = useRef<HTMLElement>(null);
  const locationRequest = useRef(0);
  const demoPending = useRef(startDemo);
  const run = useMemo(() => network ? analyzeRisk(network) : null, [network]);
  const forecast = useIcingForecast(network, !!network && showForecast && view === 'map', area, startDemo);
  const detour = useMemo(() => {
    const sections = forecast.shade?.sections;
    if (!network || !result?.normal || !sections?.length) return null;
    return findForecastDetour(network, options, result, new Set(sections.map(section => section.segmentId)), forecast.heatedWarningSegments);
  }, [network, options, result, forecast.shade, forecast.heatedWarningSegments]);
  const recommended = detour?.route ?? null;
  const route = recommended && selectedRoute !== 'normal' ? recommended : result?.normal ?? null;
  const step = navigation ? route?.steps[stepIndex] : undefined;
  const stage = step ? 'guide' : route ? 'result' : page;

  useEffect(() => {
    const controller = new AbortController();
    locationRequest.current += 1; setLocating(false);
    setDataError(''); setNetwork(null); setResult(null); setOptions(defaults);
    setOriginQuery(''); setDestinationQuery(''); setNavigation(false);
    fetchNetwork(controller.signal, area).then(actual => { if (!controller.signal.aborted) setNetwork(actual); }).catch(error => {
      if (!controller.signal.aborted) setDataError(error instanceof Error && error.name === 'TimeoutError' ? '보행망 조회 시간이 초과되었습니다. 다시 불러와 주세요.' : error instanceof Error && error.name !== 'TypeError' && error.name !== 'SyntaxError' ? error.message : '실제 자료를 불러오지 못했습니다. 다시 불러와 주세요.');
    });
    return () => controller.abort();
  }, [area, reload]);
  useEffect(() => { try { localStorage.setItem('bbzr-large-text', String(largeText)); } catch { /* optional preference */ } }, [largeText]);
  useEffect(() => { if (info) modal.current?.showModal(); else modal.current?.close(); }, [info]);
  useEffect(() => () => window.speechSynthesis?.cancel(), []);
  useEffect(() => {
    setNavigation(false); setStepIndex(0);
    window.speechSynthesis?.cancel();
  }, [route?.id]);
  useEffect(() => { window.scrollTo(0, 0); }, [stage, view]);

  function change(next: Partial<SearchOptions>) {
    locationRequest.current += 1; setLocating(false);
    setOptions(old => ({ ...old, ...next })); setResult(null); setNavigation(false); setMessage('');
    window.speechSynthesis?.cancel();
  }
  function select(kind: 'origin' | 'destination', place: Place) {
    if (kind === 'origin') setOriginQuery(place.name); else setDestinationQuery(place.name);
    change({ [kind]: place }); setSelectionMode(null);
  }
  function point(coordinate: Coordinate, kind: 'origin' | 'destination', name?: string) {
    if (!network) return;
    const place = nearestPlace(network, coordinate);
    if (!place) { setMessage('지도에 표시된 보행로 가까이에서 위치를 선택해 주세요.'); return; }
    if (name) place.name = name;
    select(kind, place);
  }
  function locate() {
    if (!navigator.geolocation) { setMessage('현재 위치를 지원하지 않는 브라우저입니다. 지도에서 출발지를 선택해 주세요.'); return; }
    const requested = ++locationRequest.current;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(position => {
      if (requested !== locationRequest.current) return;
      setLocating(false); point([position.coords.longitude, position.coords.latitude], 'origin', '현재 위치');
    }, error => {
      if (requested !== locationRequest.current) return;
      setLocating(false); setMessage(error.code === 1 ? '위치 접근을 허용하지 않았습니다. 지도에서 출발지를 선택할 수 있습니다.' : '현재 위치를 가져오지 못했습니다. 지도에서 출발지를 선택해 주세요.');
    }, { timeout: 10000, maximumAge: 30000, enableHighAccuracy: true });
  }
  function calculate(nextOptions = options, selected: Route['type'] | null = null) {
    if (!network) return;
    window.speechSynthesis?.cancel(); setNavigation(false); setSelectionMode(null);
    const next = searchRoutes(network, nextOptions);
    if (next.normal) setShowForecast(true);
    setPage('search');
    setSelectedRoute(selected); setResult(next);
    setRecenterKey(k => k + 1); setMessage(''); setStepIndex(0);
  }
  function showReplayRoute() {
    if (!network || !forecast.replay || !forecast.active) return;
    const ids = forecast.replayScene === 'gangnam' ? gangnamDemoPlaces : { origin: 'node/3404830015', destination: 'node/3404830012' };
    const origin = network.places.find(place => place.id === ids.origin);
    const destination = network.places.find(place => place.id === ids.destination);
    if (!origin || !destination) return;
    const sample = { ...defaults, origin, destination };
    locationRequest.current += 1; setLocating(false);
    setOriginQuery(origin.name); setDestinationQuery(destination.name); setOptions(sample);
    calculate(sample, 'recommended');
  }
  useEffect(() => {
    if (!demoPending.current || !network || !forecast.replay || !forecast.active) return;
    demoPending.current = false;
    showReplayRoute();
  }, [network, forecast.replay, forecast.active]);
  function speak() {
    if (!step || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(`${step.instruction}. ${Math.round(step.distanceM)}미터. 실제 위치를 추적하는 안내가 아닙니다.`);
    speech.lang = 'ko-KR'; speech.rate = .85; window.speechSynthesis.speak(speech);
  }

  function back() {
    window.speechSynthesis?.cancel();
    if (view !== 'map') { setView('map'); return; }
    if (step) { setNavigation(false); return; }
    if (route) { setResult(null); return; }
    locationRequest.current += 1;
    setLocating(false);
    setSelectionMode(null);
    setShowForecast(false);
    setPage('home');
  }

  function section(next: typeof view) {
    if (menu.current) menu.current.open = false;
    setView(next);
  }

  function chooseOnMap(kind: 'origin' | 'destination') {
    setSelectionMode(selectionMode === kind ? null : kind);
    if (selectionMode !== kind) mapSection.current?.scrollIntoView({ block: 'nearest' });
  }

  function nextStep(offset: number) {
    window.speechSynthesis?.cancel();
    if (route && stepIndex + offset >= route.steps.length) setNavigation(false);
    else setStepIndex(index => Math.max(0, index + offset));
  }

  const remaining = step && route ? route.steps.slice(stepIndex) : [];
  const title = view === 'weather' ? '기상 관측' : view === 'tmap' ? 'TMAP 길찾기'
    : stage === 'guide' ? '이동 안내' : stage === 'result' ? '경로 확인' : '경로 찾기';
  const home = view === 'map' && stage === 'home';

  return <div className={'app-shell flow-shell' + (largeText ? ' large-text' : '')}>
    <a className="skip-link" href="#walking-content">본문으로 바로가기</a>
    <main className="flow-workspace" id="walking-content">
      <header className={'flow-header' + (home ? ' flow-header-home' : '')}>
        {home ? <span className="flow-region"><MapPin size={15} />{areaLabel}</span>
          : <button className="flow-back" type="button" onClick={back} aria-label="이전 화면"><ArrowLeft size={22} /><span>이전</span></button>}
        {!home && <h1>{title}</h1>}
        <details className="flow-menu" ref={menu}>
          <summary aria-label="설정 및 다른 서비스"><Settings2 size={22} /></summary>
          <nav className="flow-menu-items" aria-label="설정 및 다른 서비스">
            <a href="/" aria-current={view === 'map' && area === 'gwanak' ? 'page' : undefined}>관악구 보행 지도</a>
            <a href="/?area=gangnam" aria-current={view === 'map' && area === 'gangnam' ? 'page' : undefined}>강남구 보행 지도</a>
            <a href="/?area=gangnam&demo=1">말죽거리 결빙 시범</a>
            <button type="button" onClick={() => section('weather')}>관악 기상 관측</button>
            <button type="button" onClick={() => section('tmap')}>TMAP 길찾기</button>
            <button type="button" aria-pressed={largeText} onClick={() => setLargeText(value => !value)}>{largeText ? '기본 글씨' : '큰 글씨'}</button>
            <button type="button" onClick={() => { if (menu.current) menu.current.open = false; setInfo(true); }}>데이터 출처</button>
          </nav>
        </details>
      </header>

      {view === 'weather' ? <Observations /> : view === 'tmap' ? <TmapPlanner />
        : !network || !run ? <section className="flow-loading" role="status">
          <Map size={30} />
          <p>{dataError || '지도를 불러오는 중…'}</p>
          {dataError && <button type="button" className="flow-primary" onClick={() => { demoPending.current = startDemo; setReload(x => x + 1); }}><RefreshCw size={18} />다시 불러오기</button>}
        </section>
        : <div className={'flow-layout stage-' + stage}>
          {stage === 'home' && <section className="flow-hero">
            <div className="flow-brand"><Snowflake size={42} strokeWidth={2.6} />빙빙제로</div>
            <h1>빙판길을 피해<br />걸어가세요</h1>
            <p>보행약자 우선 길안내</p>
          </section>}

          {stage === 'search' && <form className="flow-inputs" id="route-search" onSubmit={event => { event.preventDefault(); calculate(); }}>
            <h2>어디로 가시나요?</h2>
            <div className="place-fields">
              <PlaceInput network={network} label="출발지" kind="origin" value={originQuery} onChange={value => { setOriginQuery(value); change({ origin: null }); }} onSelect={place => select('origin', place)} />
              <PlaceInput network={network} label="목적지" kind="destination" value={destinationQuery} onChange={value => { setDestinationQuery(value); change({ destination: null }); }} onSelect={place => select('destination', place)} />
              <button type="button" className="swap-button" aria-label="출발지와 목적지 바꾸기" onClick={() => {
                setOriginQuery(destinationQuery); setDestinationQuery(originQuery); change({ origin: options.destination, destination: options.origin });
              }}><ArrowUpDown size={19} /></button>
            </div>
            <button type="button" className="flow-location" disabled={locating} onClick={locate}>
              <Navigation size={21} />{locating ? '위치 확인 중…' : '현재 위치를 출발지로'}
            </button>
            <details className="flow-options">
              <summary>보행 설정·지도에서 선택</summary>
              <div className="map-select-buttons">{(['origin', 'destination'] as const).map(kind =>
                <button type="button" key={kind} aria-pressed={selectionMode === kind} onClick={() => chooseOnMap(kind)}><MapPin size={16} />{kind === 'origin' ? '출발 위치 선택' : '도착 위치 선택'}</button>
              )}</div>
              <label className="flow-speed" htmlFor="walking-speed">보행속도<select id="walking-speed" value={options.walkingSpeedMps} onChange={e => change({ walkingSpeedMps: Number(e.target.value) })}>
                <option value={.8}>0.8m/s</option><option value={1}>1.0m/s</option><option value={1.2}>1.2m/s</option>
              </select></label>
              <label className="flow-check"><input type="checkbox" checked={options.avoidStairs} onChange={e => change({ avoidStairs: e.target.checked })} />계단 없음이 확인된 구간만</label>
              <label className="flow-check"><input type="checkbox" checked={options.maxSlopePercent === 5} onChange={e => change({ maxSlopePercent: e.target.checked ? 5 : null })} />경사 5% 이하가 확인된 구간만</label>
            </details>
            {message && <p className="flow-error" role="status">{message}</p>}
            {result && !result.normal && <p className="flow-error" role="alert">{result.message}</p>}
          </form>}

          {stage === 'result' && <div className="flow-journey" aria-label="선택한 출발지와 목적지">
            <span>{options.origin?.name}</span><ArrowRight size={18} aria-hidden="true" /><span>{options.destination?.name}</span>
          </div>}

          {step && <div className="flow-instruction"><Navigation size={30} aria-hidden="true" /><strong>{step.instruction}</strong></div>}

          <section className="flow-map" ref={mapSection} aria-label="보행 지도">
            <WalkingMap network={network} run={result?.run ?? run} normal={result?.normal ?? null} recommended={recommended}
              selected={route?.type ?? 'normal'} stage={stage} showForecast={showForecast} forecast={forecast}
              onToggleForecast={() => setShowForecast(value => !value)} onReplayRoute={showReplayRoute}
              origin={stage === 'home' ? undefined : options.origin ?? undefined}
              destination={stage === 'home' ? undefined : options.destination ?? undefined}
              step={step} recenterKey={recenterKey} selectionMode={selectionMode}
              onSelectCoordinate={coordinate => { if (selectionMode) point(coordinate, selectionMode); }} />
          </section>

          {stage === 'home' && <div className="flow-actions"><button type="button" className="flow-primary" onClick={() => setPage('search')}><MapPin size={25} />목적지 입력하기</button></div>}
          {stage === 'search' && <div className="flow-actions"><button type="submit" form="route-search" className="flow-primary"><Footprints size={24} />경로 확인하기</button></div>}

          {stage === 'result' && result?.normal && route && <section className="flow-results" aria-label="경로 비교" aria-live="polite">
            <WalkingRouteResult normal={result.normal} detour={detour} forecast={forecast} forecastEnabled={showForecast}
              selected={route.type} onSelect={setSelectedRoute} onNavigate={() => { setNavigation(true); setStepIndex(0); }} />
          </section>}

          {step && route && <section className="flow-guide" aria-label="이동 안내 미리보기">
            <div className="flow-guide-card">
              <h2>{options.destination?.name}까지</h2>
              <strong>{duration(remaining.reduce((sum, segment) => sum + segment.durationSeconds, 0))} 남음</strong>
              <span><MapPin size={17} />남은 거리 {distance(remaining.reduce((sum, segment) => sum + segment.distanceM, 0))}</span>
            </div>
            <div className="flow-guide-controls">
              <button type="button" disabled={stepIndex === 0} onClick={() => nextStep(-1)}><ChevronLeft size={18} />이전 구간</button>
              <span>{stepIndex + 1} / {route.steps.length}</span>
              <button type="button" onClick={() => nextStep(1)}>{stepIndex < route.steps.length - 1 ? '다음 구간' : '완료'}<ChevronRight size={18} /></button>
            </div>
            {'speechSynthesis' in window && <button type="button" className="flow-voice" onClick={speak}><Volume2 size={18} />이 구간 읽기</button>}
            <p className="flow-muted"><Clock3 size={16} />선택한 구간 기준 · 이동 안내 미리보기</p>
            <button type="button" className="flow-primary flow-outline" onClick={back}>안내 끝내기</button>
          </section>}
        </div>}
    </main>
    <dialog ref={modal} className="flow-source-dialog" aria-labelledby="source-title" onCancel={() => setInfo(false)} onClick={e => { if (e.target === e.currentTarget) setInfo(false); }}>
      <div className="flow-dialog-body">
        <header><h2 id="source-title">데이터 출처</h2><button type="button" aria-label="닫기" onClick={() => setInfo(false)}><X size={24} /></button></header>
        <dl>
          <dt>보행 지도</dt><dd>OpenStreetMap 공개 보행망과 장소{network && <> · {stamp(network.provenance.osmTimestamp)} KST</>}</dd>
          <dt>결빙 예상</dt><dd>기상청과 Open-Meteo 기상, OSM 건물·보행 교량, Copernicus 표면 높이, 서울시 열선 설치 기록을 사용합니다. 실제 노면 상태는 다를 수 있습니다.</dd>
          <dt>보행 시간</dt><dd>신호 대기와 장소에서 공개 보행망까지의 접근 거리는 제외합니다.</dd>
          <dt>위치 처리</dt><dd>보행 지도는 선택 위치를 브라우저에서 처리합니다. TMAP 검색·길찾기에는 입력한 장소 정보가 TMAP에 전송됩니다.</dd>
        </dl>
        {network && <p className="source-downloads"><a href={area === 'gangnam' ? '/data/gangnam/osm.json' : '/data/osm.json'} download>지도 원본 JSON</a> · <a href={area === 'gangnam' ? '/data/gangnam/provenance.json' : '/data/provenance.json'} download>출처·검증 기록</a></p>}
      </div>
    </dialog>
  </div>;
}
