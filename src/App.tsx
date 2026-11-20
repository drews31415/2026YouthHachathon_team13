import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpDown, ChevronLeft, ChevronRight, Clock3, Footprints, Map, MapPin, Navigation, RefreshCw, Snowflake, Volume2 } from 'lucide-react';
import { analyzeRisk, findHazardAvoidingRoute, nearestPlace, searchRoutes } from './core/engine';
import { coordinateInside } from './core/network';
import type { Coordinate, Network, Place, SearchOptions, SearchResult } from './core/types';
import { fetchNetwork } from './services/network';
import { fetchSeoulNetwork } from './services/seoul-network';
import { coordinatePlace } from './services/tmap';
import { aifsDemoPlaces, gangnamDemoPlaces } from './gangnam-pilot';
import { PlaceInput } from './components/PlaceInput';
import { WalkingMap } from './components/WalkingMap';
import { useIcingForecast } from './components/IcingForecastControl';
import { WalkingRouteResult } from './components/WalkingRouteResult';
import icingRegions from '../icing-regions.json';
import './walking-flow.css';

const defaults: SearchOptions = { origin: null, destination: null, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null };
const distance = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
const area = 'gangnam';
const gwanakDemoPlaces = { origin: 'node/3404830015', destination: 'node/3404830009' };

function duration(seconds: number) {
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}초` : `${Math.floor(rounded / 60)}분 ${rounded % 60}초`;
}

export default function App() {
  const [demo] = useState(() => new URLSearchParams(window.location.search).get('demo'));
  const startDemo = demo === '1' || demo === 'aifs';
  const [searchOpen, setSearchOpen] = useState(startDemo);
  const [network, setNetwork] = useState<Network | null>(null);
  const [gwanak, setGwanak] = useState<Network | null>(null);
  const [analysisNetwork, setAnalysisNetwork] = useState<Network | null>(null);
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
  const [navigationRouteId, setNavigationRouteId] = useState<string>();
  const [stepIndex, setStepIndex] = useState(0);
  const [recenterKey, setRecenterKey] = useState(0);
  const mapSection = useRef<HTMLElement>(null);
  const locationRequest = useRef(0);
  const pendingRoute = useRef<AbortController | null>(null);
  const demoPending = useRef(startDemo);
  const run = useMemo(() => network ? analyzeRisk(network) : null, [network]);
  function within(candidate: Network | null, places = options) {
    return !!candidate && [places.origin, places.destination].every(place => !place || coordinateInside(place.coordinate, candidate.bounds));
  }
  const focusedGwanak = !!(options.origin || options.destination) && within(gwanak);
  const visibleNetwork = searchOpen ? analysisNetwork ?? (focusedGwanak ? gwanak : network) : network;
  const modelArea = visibleNetwork && visibleNetwork === gwanak ? 'gwanak' : area;
  const showForecast = searchOpen && (!!analysisNetwork || focusedGwanak || within(network));
  const forecast = useIcingForecast(visibleNetwork, showForecast, modelArea, startDemo, demo === '1' ? 'gangnam' : 'aifs');
  const searchNetwork = useMemo(() => network && gwanak ? { ...network, places: [...network.places, ...gwanak.places] } : network, [network, gwanak]);
  const forecastReady = !!forecast.active && !forecast.incomplete;
  const { route, comparison } = useMemo(() => {
    if (!analysisNetwork || !result?.normal || !forecastReady) return { route: null, comparison: null };
    const icingSegments = new Set((forecast.shade?.sections ?? []).map(section => section.segmentId));
    const route = findHazardAvoidingRoute(analysisNetwork, options, result, icingSegments);
    const warningCount = forecast.aiModel && route ? result.normal.segmentIds.filter(id => icingSegments.has(id)).length : 0;
    return { route, comparison: warningCount > 0 ? { normal: result.normal, warningCount } : null };
  }, [analysisNetwork, options, result, forecast.shade, forecast.aiModel, forecastReady]);
  const step = route && navigationRouteId === route.id ? route.steps[stepIndex] : undefined;
  const stage = !searchOpen ? 'home' : step ? 'guide' : result?.normal ? 'result' : 'search';

  useEffect(() => {
    const controller = new AbortController();
    locationRequest.current += 1; setLocating(false);
    setDataError(''); setNetwork(null); setResult(null); setOptions(defaults);
    setOriginQuery(''); setDestinationQuery(''); setNavigationRouteId(undefined);
    fetchNetwork(controller.signal, area).then(actual => { if (!controller.signal.aborted) setNetwork(actual); }).catch(error => {
      if (!controller.signal.aborted) setDataError(error instanceof Error && error.name === 'TimeoutError' ? '보행망 조회 시간이 초과되었습니다. 다시 불러와 주세요.' : error instanceof Error && error.name !== 'TypeError' && error.name !== 'SyntaxError' ? error.message : '실제 자료를 불러오지 못했습니다. 다시 불러와 주세요.');
    });
    void fetchNetwork(controller.signal, 'gwanak').then(actual => { if (!controller.signal.aborted) setGwanak(actual); }).catch(() => {});
    return () => controller.abort();
  }, [reload]);
  useEffect(() => () => { pendingRoute.current?.abort(); window.speechSynthesis?.cancel(); }, []);
  useEffect(() => {
    setNavigationRouteId(undefined); setStepIndex(0);
    window.speechSynthesis?.cancel();
  }, [route?.id]);
  useEffect(() => { window.scrollTo(0, 0); }, [stage]);

  function change(next: Partial<SearchOptions>) {
    locationRequest.current += 1; setLocating(false);
    pendingRoute.current?.abort(); setRouting(false);
    setOptions(old => ({ ...old, ...next })); setResult(null); setAnalysisNetwork(null); setNavigationRouteId(undefined); setMessage('');
    window.speechSynthesis?.cancel();
  }
  function select(kind: 'origin' | 'destination', place: Place) {
    if (kind === 'origin') setOriginQuery(place.name); else setDestinationQuery(place.name);
    change({ [kind]: place }); setSelectionMode(null);
  }
  function point(coordinate: Coordinate, kind: 'origin' | 'destination', name?: string) {
    if (!network) return;
    const place = nearestPlace(visibleNetwork ?? network, coordinate) ?? coordinatePlace(coordinate, '지도에서 선택한 위치');
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
  async function calculate(nextOptions = options) {
    if (!network || !run) return;
    const { origin, destination } = nextOptions;
    if (!origin || !destination) { setMessage('검색 결과나 지도에서 출발지와 목적지를 선택해 주세요.'); return; }
    pendingRoute.current?.abort();
    locationRequest.current += 1; setLocating(false);
    window.speechSynthesis?.cancel(); setNavigationRouteId(undefined); setSelectionMode(null);
    setRecenterKey(k => k + 1); setMessage(''); setStepIndex(0);
    const controller = new AbortController();
    pendingRoute.current = controller;
    setResult(null); setAnalysisNetwork(null); setRouting(true);
    try {
      const local = within(gwanak, nextOptions) ? gwanak : within(network, nextOptions) ? network : null;
      const routeWith = (graph: Network) => {
        const connect = (place: Place) => {
          if (graph === local && graph.nodes.some(node => node.id === place.nodeId)) return place;
          const snapped = nearestPlace(graph, place.coordinate);
          return snapped ? { ...place, nodeId: snapped.nodeId, routeCoordinate: snapped.routeCoordinate, snapDistanceM: snapped.snapDistanceM } : place;
        };
        const settings = { ...nextOptions, origin: connect(origin), destination: connect(destination) };
        return { settings, result: searchRoutes(graph, settings) };
      };
      let graph = local;
      let calculated = graph ? routeWith(graph) : null;
      // Use the shared Seoul graph for live searches so alternatives can leave the pilot map.
      if (!local || !forecast.replay) {
        try {
          const seoul = await fetchSeoulNetwork(origin.coordinate, destination.coordinate, controller.signal);
          if (seoul) {
            const cityRoute = routeWith(seoul);
            if (cityRoute.result.normal || !calculated?.result.normal) { graph = seoul; calculated = cityRoute; }
          }
        } catch {
          if (!controller.signal.aborted && !calculated?.result.normal) {
            setMessage('서울 보행망을 불러오지 못했어요. 다시 시도해 주세요.');
            return;
          }
        }
      }
      controller.signal.throwIfAborted();
      if (!graph || !calculated) {
        setMessage('안내 가능한 경로 없음 · 서울 보행망 범위를 벗어났어요.');
        return;
      }
      if (calculated.result.normal) {
        setAnalysisNetwork(graph);
        setOptions(calculated.settings);
      }
      setResult(calculated.result);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error && error.name !== 'TypeError' && error.name !== 'TimeoutError'
        ? error.message : '보행 경로를 불러오지 못했어요. 다시 시도해 주세요.');
    } finally {
      if (pendingRoute.current === controller) { pendingRoute.current = null; setRouting(false); }
    }
  }
  function showReplayRoute() {
    if (!visibleNetwork || !forecast.replay || !forecast.active) return;
    const ids = forecast.replayScene === 'aifs' ? aifsDemoPlaces
      : modelArea === 'gwanak' ? gwanakDemoPlaces : gangnamDemoPlaces;
    const origin = visibleNetwork.places.find(place => place.id === ids.origin);
    const destination = visibleNetwork.places.find(place => place.id === ids.destination);
    if (!origin || !destination) return;
    const sample = { ...defaults, origin, destination };
    locationRequest.current += 1; setLocating(false);
    setOriginQuery(origin.name); setDestinationQuery(destination.name); setOptions(sample);
    void calculate(sample);
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
    if (step) { setNavigationRouteId(undefined); return; }
    if (result?.normal) { setResult(null); setAnalysisNetwork(null); return; }
    change({});
    setSelectionMode(null);
    setSearchOpen(false);
  }

  function chooseOnMap(kind: 'origin' | 'destination') {
    setSelectionMode(selectionMode === kind ? null : kind);
    if (selectionMode !== kind) mapSection.current?.scrollIntoView({ block: 'nearest' });
  }

  function nextStep(offset: number) {
    window.speechSynthesis?.cancel();
    if (route && stepIndex + offset >= route.steps.length) setNavigationRouteId(undefined);
    else setStepIndex(index => Math.max(0, index + offset));
  }

  const remaining = step && route ? route.steps.slice(stepIndex) : [];
  const title = stage === 'guide' ? '이동 안내' : stage === 'result' ? '경로 확인' : '경로 찾기';

  return <div className="app-shell flow-shell">
    <a className="skip-link" href="#walking-content">본문으로 바로가기</a>
    <main className="flow-workspace" id="walking-content">
      <header className={stage === 'home' ? 'flow-header flow-header-home' : 'flow-header'}>
        {stage === 'home' ? <span className="flow-region"><MapPin size={15} aria-hidden="true" />{icingRegions[area].label}</span>
          : <>
            <button className="flow-back" type="button" onClick={back} aria-label="이전 화면"><ArrowLeft size={22} /><span>이전</span></button>
            <h1>{title}</h1>
          </>}
      </header>

      {!network || !run || !visibleNetwork || !searchNetwork ? <section className="flow-loading" role="status">
          <Map size={30} />
          <p>{dataError || '지도를 불러오는 중…'}</p>
          {dataError && <button type="button" className="flow-primary" onClick={() => { demoPending.current = startDemo; setReload(x => x + 1); }}><RefreshCw size={18} />다시 불러오기</button>}
        </section>
        : <div className={'flow-layout stage-' + stage}>
          {stage === 'home' && <section className="flow-hero">
            <div className="flow-brand"><Snowflake size={42} strokeWidth={2.6} aria-hidden="true" />빙빙제로</div>
            <h1>빙판길을 피해<br />걸어가세요</h1>
            <p>보행약자 우선 길안내</p>
          </section>}

          {stage === 'search' && <form className="flow-inputs" id="route-search" onSubmit={event => { event.preventDefault(); calculate(); }}>
            <h2>어디로 가시나요?</h2>
            <div className="place-fields">
              <PlaceInput network={searchNetwork} selected={options.origin} label="출발지" kind="origin" value={originQuery} onChange={value => { setOriginQuery(value); change({ origin: null }); }} onSelect={place => select('origin', place)} />
              <PlaceInput network={searchNetwork} selected={options.destination} label="목적지" kind="destination" value={destinationQuery} onChange={value => { setDestinationQuery(value); change({ destination: null }); }} onSelect={place => select('destination', place)} />
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
            </details>
            {message && <p className="flow-error" role="status">{message}</p>}
            {result && !result.normal && !message && <p className="flow-error" role="alert">
              {result.status === 'no-route' && '안내 가능한 경로 없음 · '}{result.message}
            </p>}
          </form>}

          {stage === 'result' && <div className="flow-journey" aria-label="선택한 출발지와 목적지">
            <span>{options.origin?.name}</span><ArrowRight size={18} aria-hidden="true" /><span>{options.destination?.name}</span>
          </div>}

          {step && <div className="flow-instruction"><Navigation size={30} aria-hidden="true" /><strong>{step.instruction}</strong></div>}

          <section className="flow-map" ref={mapSection} aria-label="보행 지도">
            <WalkingMap network={visibleNetwork} run={result?.run ?? run} route={route}
              comparisonRoute={stage === 'result' ? comparison?.normal : undefined}
              stage={stage} showForecast={showForecast} forecast={forecast} onReplayRoute={showReplayRoute}
              origin={searchOpen ? options.origin ?? undefined : undefined}
              destination={searchOpen ? options.destination ?? undefined : undefined}
              step={step} recenterKey={recenterKey} selectionMode={selectionMode}
              onSelectCoordinate={coordinate => { if (selectionMode) point(coordinate, selectionMode); }} />
          </section>

          {stage === 'home' && <div className="flow-actions"><button type="button" className="flow-primary" onClick={() => setSearchOpen(true)}><MapPin size={25} aria-hidden="true" />목적지 입력하기</button></div>}
          {stage === 'search' && <div className="flow-actions"><button type="submit" form="route-search" className="flow-primary" disabled={routing}><Footprints size={24} />{routing ? '경로를 찾는 중…' : '경로 확인하기'}</button></div>}

          {stage === 'result' && <section className="flow-results" aria-label="경로 결과" aria-live="polite">
            <WalkingRouteResult route={route} comparison={comparison} forecast={forecast} onNavigate={() => { if (route) { setNavigationRouteId(route.id); setStepIndex(0); } }} />
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
