import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpDown, ChevronLeft, ChevronRight, Clock3, Footprints, Map, MapPin, Navigation, RefreshCw, Volume2 } from 'lucide-react';
import { analyzeRisk, findForecastDetour, nearestPlace, searchRoutes } from './core/engine';
import { coordinateInside } from './core/network';
import type { Coordinate, Network, Place, Route, SearchOptions, SearchResult } from './core/types';
import { fetchNetwork } from './services/network';
import { coordinatePlace, fetchTmapWalkingRoute } from './services/tmap';
import { gangnamDemoPlaces } from './gangnam-pilot';
import { PlaceInput } from './components/PlaceInput';
import { WalkingMap } from './components/WalkingMap';
import { useIcingForecast } from './components/IcingForecastControl';
import { WalkingRouteResult } from './components/WalkingRouteResult';
import './walking-flow.css';

const defaults: SearchOptions = { origin: null, destination: null, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null };
const distance = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
const area = 'gangnam';

function duration(seconds: number) {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}초` : `${Math.floor(rounded / 60)}분 ${rounded % 60}초`;
}

export default function App() {
  const [startDemo] = useState(() => new URLSearchParams(window.location.search).get('demo') === '1');
  const [network, setNetwork] = useState<Network | null>(null);
  const [dataError, setDataError] = useState('');
  const [reload, setReload] = useState(0);
  const [options, setOptions] = useState<SearchOptions>(defaults);
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [routing, setRouting] = useState(false);
  const [message, setMessage] = useState('');
  const [locating, setLocating] = useState(false);
  const [selectionMode, setSelectionMode] = useState<'origin' | 'destination' | null>(null);
  const [navigation, setNavigation] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [recenterKey, setRecenterKey] = useState(0);
  const [showForecast, setShowForecast] = useState(startDemo);
  const [selectedRoute, setSelectedRoute] = useState<Route['type'] | null>(null);
  const mapSection = useRef<HTMLElement>(null);
  const locationRequest = useRef(0);
  const pendingRoute = useRef<AbortController | null>(null);
  const demoPending = useRef(startDemo);
  const run = useMemo(() => network ? analyzeRisk(network) : null, [network]);
  const hasOutsideEndpoint = network && [options.origin, options.destination].some(place => place && !coordinateInside(place.coordinate, network.bounds));
  const allowForecast = !hasOutsideEndpoint && result?.normal?.provider !== 'tmap';
  const forecast = useIcingForecast(network, !!network && showForecast && allowForecast, area, startDemo);
  const detour = useMemo(() => {
    const sections = forecast.shade?.sections;
    if (!network || !result?.normal || result.normal.provider || !sections?.length) return null;
    return findForecastDetour(network, options, result, new Set(sections.map(section => section.segmentId)), forecast.heatedWarningSegments);
  }, [network, options, result, forecast.shade, forecast.heatedWarningSegments]);
  const recommended = detour?.route ?? null;
  const route = recommended && selectedRoute !== 'normal' ? recommended : result?.normal ?? null;
  const step = navigation ? route?.steps[stepIndex] : undefined;
  const stage = step ? 'guide' : route ? 'result' : 'search';

  useEffect(() => {
    const controller = new AbortController();
    locationRequest.current += 1; setLocating(false);
    setDataError(''); setNetwork(null); setResult(null); setOptions(defaults);
    setOriginQuery(''); setDestinationQuery(''); setNavigation(false);
    fetchNetwork(controller.signal, area).then(actual => { if (!controller.signal.aborted) setNetwork(actual); }).catch(error => {
      if (!controller.signal.aborted) setDataError(error instanceof Error && error.name === 'TimeoutError' ? '보행망 조회 시간이 초과되었습니다. 다시 불러와 주세요.' : error instanceof Error && error.name !== 'TypeError' && error.name !== 'SyntaxError' ? error.message : '실제 자료를 불러오지 못했습니다. 다시 불러와 주세요.');
    });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => () => { pendingRoute.current?.abort(); window.speechSynthesis?.cancel(); }, []);
  useEffect(() => {
    setNavigation(false); setStepIndex(0);
    window.speechSynthesis?.cancel();
  }, [route?.id]);
  useEffect(() => { window.scrollTo(0, 0); }, [stage]);

  function change(next: Partial<SearchOptions>) {
    locationRequest.current += 1; setLocating(false);
    pendingRoute.current?.abort(); setRouting(false);
    setOptions(old => ({ ...old, ...next })); setResult(null); setNavigation(false); setMessage('');
    window.speechSynthesis?.cancel();
  }
  function select(kind: 'origin' | 'destination', place: Place) {
    if (kind === 'origin') setOriginQuery(place.name); else setDestinationQuery(place.name);
    change({ [kind]: place }); setSelectionMode(null);
  }
  function point(coordinate: Coordinate, kind: 'origin' | 'destination', name?: string) {
    if (!network) return;
    const place = nearestPlace(network, coordinate) ?? coordinatePlace(coordinate, '지도에서 선택한 위치');
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
  async function calculate(nextOptions = options, selected: Route['type'] | null = null) {
    if (!network || !run) return;
    const { origin, destination } = nextOptions;
    if (!origin || !destination) { setMessage('검색 결과나 지도에서 출발지와 목적지를 선택해 주세요.'); return; }
    pendingRoute.current?.abort();
    setRouting(false);
    window.speechSynthesis?.cancel(); setNavigation(false); setSelectionMode(null);
    setRecenterKey(k => k + 1); setMessage(''); setStepIndex(0);
    const connect = (place: Place) => {
      if (place.nodeId) return place;
      const snapped = nearestPlace(network, place.coordinate);
      return snapped ? { ...snapped, name: place.name, address: place.address } : place;
    };
    const localOptions = { ...nextOptions, origin: connect(origin), destination: connect(destination) };
    const next = searchRoutes(network, localOptions);
    setSelectedRoute(selected);
    if (next.normal) {
      setOptions(localOptions); setResult(next); setShowForecast(true);
      return;
    }
    if (nextOptions.maxSlopePercent !== null) {
      setResult(next);
      if (next.status === 'out-of-area') setMessage('이 지역에는 확인된 경사 정보가 부족해요. 경사 조건을 해제하면 일반 보행 경로를 검색할 수 있어요.');
      return;
    }
    // Preserve the stricter stair filter where the local graph can be evaluated.
    if (nextOptions.avoidStairs && next.status === 'no-route') { setResult(next); return; }
    const controller = new AbortController();
    pendingRoute.current = controller;
    setResult(null); setRouting(true);
    try {
      const normal = await fetchTmapWalkingRoute(origin, destination, nextOptions, controller.signal);
      if (!controller.signal.aborted) setResult({ status: 'ok', message: '', run, normal, recommended: null, extraSeconds: null });
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error && error.name !== 'TypeError' && error.name !== 'TimeoutError'
        ? error.message : '보행 경로를 불러오지 못했어요. 다시 시도해 주세요.');
    } finally {
      if (pendingRoute.current === controller) { pendingRoute.current = null; setRouting(false); }
    }
  }
  function showReplayRoute() {
    if (!network || !forecast.replay || !forecast.active) return;
    const ids = gangnamDemoPlaces;
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
    if (step) { setNavigation(false); return; }
    if (route) { setResult(null); return; }
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
  const title = stage === 'guide' ? '이동 안내' : stage === 'result' ? '경로 확인' : '빙빙제로';

  return <div className="app-shell flow-shell">
    <a className="skip-link" href="#walking-content">본문으로 바로가기</a>
    <main className="flow-workspace" id="walking-content">
      <header className="flow-header">
        {stage !== 'search' && <button className="flow-back" type="button" onClick={back} aria-label="이전 화면"><ArrowLeft size={22} /><span>이전</span></button>}
        <h1>{title}</h1>
      </header>

      {!network || !run ? <section className="flow-loading" role="status">
          <Map size={30} />
          <p>{dataError || '지도를 불러오는 중…'}</p>
          {dataError && <button type="button" className="flow-primary" onClick={() => { demoPending.current = startDemo; setReload(x => x + 1); }}><RefreshCw size={18} />다시 불러오기</button>}
        </section>
        : <div className={'flow-layout stage-' + stage}>
          {stage === 'search' && <form className="flow-inputs" id="route-search" onSubmit={event => { event.preventDefault(); calculate(); }}>
            <h2>어디로 가시나요?</h2>
            <div className="place-fields">
              <PlaceInput network={network} selected={options.origin} label="출발지" kind="origin" value={originQuery} onChange={value => { setOriginQuery(value); change({ origin: null }); }} onSelect={place => select('origin', place)} />
              <PlaceInput network={network} selected={options.destination} label="목적지" kind="destination" value={destinationQuery} onChange={value => { setDestinationQuery(value); change({ destination: null }); }} onSelect={place => select('destination', place)} />
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
              <label className="flow-check"><input type="checkbox" checked={options.avoidStairs} onChange={e => change({ avoidStairs: e.target.checked })} />계단 피하기</label>
              <label className="flow-check"><input type="checkbox" checked={options.maxSlopePercent === 5} onChange={e => change({ maxSlopePercent: e.target.checked ? 5 : null })} />경사 5% 이하가 확인된 구간만</label>
            </details>
            {message && <p className="flow-error" role="status">{message}</p>}
            {result && !result.normal && !message && <p className="flow-error" role="alert">{result.message}</p>}
          </form>}

          {stage === 'result' && <div className="flow-journey" aria-label="선택한 출발지와 목적지">
            <span>{options.origin?.name}</span><ArrowRight size={18} aria-hidden="true" /><span>{options.destination?.name}</span>
          </div>}

          {step && <div className="flow-instruction"><Navigation size={30} aria-hidden="true" /><strong>{step.instruction}</strong></div>}

          <section className="flow-map" ref={mapSection} aria-label="보행 지도">
            <WalkingMap network={network} run={result?.run ?? run} normal={result?.normal ?? null} recommended={recommended}
              selected={route?.type ?? 'normal'} stage={stage} showForecast={showForecast && allowForecast} allowForecast={allowForecast} forecast={forecast}
              onToggleForecast={() => setShowForecast(value => !value)} onReplayRoute={showReplayRoute}
              origin={options.origin ?? undefined}
              destination={options.destination ?? undefined}
              step={step} recenterKey={recenterKey} selectionMode={selectionMode}
              onSelectCoordinate={coordinate => { if (selectionMode) point(coordinate, selectionMode); }} />
          </section>

          {stage === 'search' && <div className="flow-actions"><button type="submit" form="route-search" className="flow-primary" disabled={routing}><Footprints size={24} />{routing ? '경로를 찾는 중…' : '경로 확인하기'}</button></div>}

          {stage === 'result' && result?.normal && route && <section className="flow-results" aria-label="경로 비교" aria-live="polite">
            <WalkingRouteResult normal={result.normal} detour={detour} forecast={forecast} forecastEnabled={showForecast && allowForecast}
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
  </div>;
}
