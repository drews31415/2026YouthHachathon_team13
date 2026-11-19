import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, Footprints, Info, LocateFixed, Map, MapPin, Navigation, RefreshCw, Settings2, Snowflake, Type, Volume2, X } from 'lucide-react';
import { analyzeRisk, findForecastDetour, nearestPlace, searchRoutes } from './core/engine';
import type { Coordinate, Network, Place, Route, SearchOptions, SearchResult } from './core/types';
import { fetchNetwork } from './services/network';
import type { IcingArea } from './services/icing-weather';
import icingRegions from '../icing-regions.json';
import { gangnamDemoPlaces } from './gangnam-pilot';
import gangnamCrossings from './gangnam-crossings.json';
import { PlaceInput } from './components/PlaceInput';
import { WalkingMap } from './components/WalkingMap';
import { useIcingForecast } from './components/IcingForecastControl';
import { WalkingRouteResult } from './components/WalkingRouteResult';
import Observations from './components/Observations';
import TmapPlanner from './components/TmapPlanner';

const defaults: SearchOptions = { origin: null, destination: null, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null };
const distance = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
const stamp = (s: string) => new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });

export default function App() {
  const [area] = useState<IcingArea>(() => new URLSearchParams(window.location.search).get('area') === 'gangnam' ? 'gangnam' : 'gwanak');
  const areaLabel = icingRegions[area].label;
  const [startDemo] = useState(() => area === 'gangnam' && new URLSearchParams(window.location.search).get('demo') === '1');
  const [view, setView] = useState<'map' | 'weather' | 'tmap'>('map');
  const [network, setNetwork] = useState<Network | null>(null);
  const [dataError, setDataError] = useState('');
  const [reload, setReload] = useState(0);
  const [options, setOptions] = useState<SearchOptions>(defaults);
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [message, setMessage] = useState('');
  const [locating, setLocating] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [info, setInfo] = useState(false);
  const [largeText, setLargeText] = useState(() => { try { return localStorage.getItem('bbzr-large-text') === 'true'; } catch { return false; } });
  const [selectionMode, setSelectionMode] = useState<'origin' | 'destination' | null>(null);
  const [navigation, setNavigation] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [recenterKey, setRecenterKey] = useState(0);
  const [showForecast, setShowForecast] = useState(startDemo);
  const [selectedRoute, setSelectedRoute] = useState<Route['type']>('normal');
  const modal = useRef<HTMLDialogElement>(null);
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
  const route = selectedRoute === 'recommended' && recommended ? recommended : result?.normal ?? null;
  const step = navigation ? route?.steps[stepIndex] : undefined;

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
  useEffect(() => { if (!recommended) setSelectedRoute('normal'); }, [recommended]);

  function change(next: Partial<SearchOptions>) {
    locationRequest.current += 1; setLocating(false);
    setOptions(old => ({ ...old, ...next })); setResult(null); setNavigation(false); setMessage('');
    window.speechSynthesis?.cancel();
  }
  function select(kind: 'origin' | 'destination', place: Place) {
    if (kind === 'origin') setOriginQuery(place.name); else setDestinationQuery(place.name);
    change({ [kind]: place }); setSelectionMode(null);
  }
  function point(coordinate: Coordinate, kind: 'origin' | 'destination', name?: string, accuracyM?: number) {
    if (!network) return;
    const place = nearestPlace(network, coordinate);
    if (!place) { setMessage('수집 영역 안의 보행망에서 80m 이내인 위치를 선택해 주세요. 연결되지 않은 길을 임의로 만들지 않습니다.'); return; }
    if (name) place.name = name;
    select(kind, place);
    const accuracy = accuracyM !== undefined && Number.isFinite(accuracyM) ? `기기가 보고한 위치 정확도 반경 ${distance(accuracyM)}. ` : '';
    setMessage(`${accuracy}선택 위치에서 경로 연결점까지 직선거리 ${distance(place.snapDistanceM)}입니다. 그 사이 접근로는 미확인으로 경로·시간에서 제외합니다.`);
  }
  function locate() {
    if (!navigator.geolocation) { setMessage('현재 위치를 지원하지 않는 브라우저입니다. 지도에서 출발지를 선택해 주세요.'); return; }
    const requested = ++locationRequest.current;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(position => {
      if (requested !== locationRequest.current) return;
      setLocating(false); point([position.coords.longitude, position.coords.latitude], 'origin', '현재 위치', position.coords.accuracy);
    }, error => {
      if (requested !== locationRequest.current) return;
      setLocating(false); setMessage(error.code === 1 ? '위치 접근을 허용하지 않았습니다. 지도에서 출발지를 선택할 수 있습니다.' : '현재 위치를 가져오지 못했습니다. 지도에서 출발지를 선택해 주세요.');
    }, { timeout: 10000, maximumAge: 30000, enableHighAccuracy: true });
  }
  function calculate(nextOptions = options, selected: Route['type'] = 'normal') {
    if (!network) return;
    window.speechSynthesis?.cancel(); setNavigation(false); setSelectionMode(null);
    const next = searchRoutes(network, nextOptions);
    if (next.normal) setShowForecast(true);
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

  return <div className={`app-shell ${largeText ? 'large-text' : ''}`}>
    <a className="skip-link" href="#service-views">서비스 선택으로 바로가기</a>
    <aside className="side-rail" aria-label="주 메뉴"><a className="rail-brand" href="#service-views" onClick={() => setView('map')}><Snowflake size={32} /><span>빙빙제로</span></a><div className="rail-divider" /><a className="rail-item active" href="#route-search" onClick={() => setView('map')}><Map size={23} /><span>길찾기</span></a><button className="rail-item" onClick={() => setInfo(true)}><Info size={22} /><span>데이터 출처</span></button><div className="rail-bottom"><span className="rail-beta">PUBLIC DATA</span></div></aside>
    <main className="workspace">
      <header className="page-header"><div className="header-heading"><span className="mobile-brand"><Snowflake size={23} />빙빙제로</span><span className="header-eyebrow">PUBLIC DATA, EVERY STEP</span><h1>확인된 자료로, 한 걸음씩<span>.</span></h1><p>공개 지도와 기상을 확인하고 보행 경로를 살펴보세요.</p></div><div className="header-actions"><span className="simulation-badge"><i />공개 실자료</span><button className={`text-toggle ${largeText ? 'active' : ''}`} aria-pressed={largeText} onClick={() => setLargeText(!largeText)}><Type size={18} />큰 글씨</button><button className="mobile-info" aria-label="데이터 출처" onClick={() => setInfo(true)}><Info size={20} /></button></div></header>
      <nav id="service-views" className="service-views" aria-label="조회할 서비스">
        <button type="button" aria-pressed={view === 'map' && area === 'gwanak'} onClick={() => area === 'gwanak' ? setView('map') : window.location.assign('/')}>관악구 보행 지도</button>
        <button type="button" aria-pressed={view === 'map' && area === 'gangnam'} onClick={() => area === 'gangnam' ? setView('map') : window.location.assign('/?area=gangnam')}>강남구 보행 지도</button>
        <button type="button" aria-pressed={view === 'weather'} onClick={() => setView('weather')}>{area === 'gangnam' ? '관악 기상 관측' : '동네 기상 관측'}</button>
        <button type="button" aria-pressed={view === 'tmap'} onClick={() => setView('tmap')}>TMAP 길찾기</button>
      </nav>
      {view === 'weather' ? <Observations /> : view === 'tmap' ? <section className="external-planner"><TmapPlanner /><button className="location-button" type="button" onClick={() => setView('map')}><Map size={16} />{areaLabel} 보행 지도에서 계속</button></section> : !network || !run ? <section className="data-loading" role="status"><Map size={32} /><h2>{dataError ? '실제 자료를 불러오지 못했어요' : '공개 보행망을 확인하고 있어요'}</h2><p>{dataError || '원본과 출처 기록을 확인한 뒤 지도를 표시합니다.'}</p>{dataError && <button className="primary-button" onClick={() => setReload(x => x + 1)}><RefreshCw size={18} />다시 불러오기</button>}</section> : <div className="main-layout">
        <section className="planner" aria-label="보행 경로 계획">
          {!navigation ? <><form className="search-section" id="route-search" onSubmit={e => { e.preventDefault(); calculate(); }}>
            <div className="section-heading"><h2>어디로 걸어가세요?</h2><span className="walking-label"><Footprints size={15} />도보</span></div>
            <div className="place-fields"><PlaceInput network={network} label="출발지" kind="origin" value={originQuery} onChange={value => { setOriginQuery(value); change({ origin: null }); }} onSelect={place => select('origin', place)} /><div className="field-divider" /><PlaceInput network={network} label="목적지" kind="destination" value={destinationQuery} onChange={value => { setDestinationQuery(value); change({ destination: null }); }} onSelect={place => select('destination', place)} /><button type="button" className="swap-button" aria-label="출발지와 목적지 바꾸기" onClick={() => { setOriginQuery(destinationQuery); setDestinationQuery(originQuery); change({ origin: options.destination, destination: options.origin }); }}><ArrowUpDown size={18} /></button></div>
            <div className="map-select-buttons">{(['origin', 'destination'] as const).map(kind => <button type="button" key={kind} aria-pressed={selectionMode === kind} onClick={() => setSelectionMode(selectionMode === kind ? null : kind)}><MapPin size={16} />지도에서 {kind === 'origin' ? '출발' : '도착'} 선택</button>)}</div>
            <div className="search-secondary"><button type="button" className="location-button" disabled={locating} onClick={locate}><LocateFixed size={16} />{locating ? '위치 확인 중…' : '현재 위치에서 출발'}</button><button type="button" className="preferences-button" aria-expanded={preferences} onClick={() => setPreferences(!preferences)}><Settings2 size={16} />보행 설정<ChevronDown size={14} /></button></div>
            {selectionMode && <p className="inline-message" role="status">지도에서 {selectionMode === 'origin' ? '출발' : '도착'} 위치를 눌러 주세요.</p>}{message && <p className="inline-message" role="status">{message}</p>}
            {(options.origin || options.destination) && <div className="endpoint-note">{[options.origin, options.destination].map((p, i) => p && <div key={i}>{i ? '도착' : '출발'} 접근 공백: 직선 {distance(p.snapDistanceM)}{p.sourceUrl && <> · <a href={p.sourceUrl} target="_blank" rel="noreferrer">지도 원본</a></>}</div>)}<small>접근 공백은 장소 좌표와 보행 경로 시작·끝 사이의 직선거리입니다. 실제 접근로가 확인되지 않아 경로와 소요시간에서 제외합니다.</small></div>}
            {preferences && <div className="preferences-panel"><label className="speed-label" htmlFor="walking-speed">계산에 사용할 보행속도<select id="walking-speed" value={options.walkingSpeedMps} onChange={e => change({ walkingSpeedMps: Number(e.target.value) })}><option value={.8}>천천히 · 초당 0.8m</option><option value={1}>여유롭게 · 초당 1.0m</option><option value={1.2}>보통 · 초당 1.2m</option></select></label><label className="check-row"><input type="checkbox" checked={options.avoidStairs} onChange={e => change({ avoidStairs: e.target.checked })} />계단 없음이 확인된 구간만</label><label className="check-row"><input type="checkbox" checked={options.maxSlopePercent === 5} onChange={e => change({ maxSlopePercent: e.target.checked ? 5 : null })} />경사 5% 이하가 확인된 구간만</label><small>공개 지도에 해당 정보가 없으면 제외합니다. 조건에 맞는 경로가 없을 수 있습니다.</small></div>}
            <button type="submit" className="primary-button search-button"><Footprints size={20} />경로 찾기<ArrowRight size={19} /></button>
            {area === 'gangnam' && !startDemo && <a className="location-button" href="/?area=gangnam&demo=1">말죽거리 결빙·우회 시범 보기<ArrowRight size={16} /></a>}
          </form><section className="results-section" aria-label="경로 결과" aria-live="polite"><div className="section-heading"><h2>실제 지도 기반 경로</h2><span className="result-context">{areaLabel}</span></div>
            {!result ? <div className="empty-result"><div className="empty-icon"><Footprints size={27} /></div><strong>출발지와 목적지를 선택하세요</strong><p>공개 지도에 등록된 장소를 검색하거나<br />지도에서 직접 선택할 수 있어요.</p></div>
              : result.normal && route ? <WalkingRouteResult normal={result.normal} detour={detour} forecast={forecast} forecastEnabled={showForecast}
                selected={route.type} speed={options.walkingSpeedMps} onSelect={setSelectedRoute}
                onNavigate={() => { setNavigation(true); setStepIndex(0); }} />
              : <div className="result-notice warning" role="status"><Info size={19} /><div><strong>경로를 찾지 못했어요</strong><p>{result.message}</p></div></div>}
            <div className="safety-note"><Info size={15} /><p>보행로별 실제 결빙 상태는 미확인입니다.</p></div>{area === 'gwanak' && <button className="location-button" onClick={() => setView('weather')}><Info size={16} />주변 관측소의 기온·강수 보기</button>}
          </section></> : <section className="navigation-section" aria-label="경로 순서 살펴보기"><button className="back-button" onClick={() => { setNavigation(false); window.speechSynthesis?.cancel(); }}><ArrowLeft size={17} />경로 결과로</button><div className="navigation-heading"><span className="eyebrow">ROUTE PREVIEW</span><h2>{options.destination?.name}까지<br />경로 순서를 확인하세요.</h2><span className="demo-nav-pill">GPS 위치 추적·자동 안내 없음</span></div>{step && <><div className="direction-card"><Navigation size={33} /><span>{step.instruction}</span><strong>{distance(step.distanceM)}<small>{step.name}</small></strong></div><div className="remaining-stats"><span>남은 경로 <strong>{distance(route!.steps.slice(stepIndex).reduce((sum, s) => sum + s.distanceM, 0))}</strong></span></div>{'speechSynthesis' in window && <button className="voice-button" onClick={speak}><Volume2 size={17} />이 구간 읽기</button>}<div className="step-progress"><span>구간 {stepIndex + 1} / {route!.steps.length}</span><div><i style={{ width: `${(stepIndex + 1) / route!.steps.length * 100}%` }} /></div></div><div className="step-buttons"><button disabled={!stepIndex} onClick={() => { window.speechSynthesis?.cancel(); setStepIndex(i => i - 1); }}><ChevronLeft size={18} />이전</button><button className="primary-button" onClick={() => { window.speechSynthesis?.cancel(); if (stepIndex < route!.steps.length - 1) setStepIndex(i => i + 1); else setNavigation(false); }}>{stepIndex < route!.steps.length - 1 ? '다음 구간' : '살펴보기 완료'}<ChevronRight size={18} /></button></div><ol className="route-steps">{route!.steps.map((s, i) => <li key={s.segmentId} className={i === stepIndex ? 'current' : ''}><button aria-current={i === stepIndex ? 'step' : undefined} onClick={() => { window.speechSynthesis?.cancel(); setStepIndex(i); }}><span className="step-number">{i + 1}</span><span><strong>{s.name}</strong><small>{s.instruction} · {distance(s.distanceM)}</small></span></button></li>)}</ol></>}</section>}
          <div className="planner-footer"><span><Snowflake size={14} />확인되지 않은 값은 비워 둡니다.</span><button onClick={() => setInfo(true)}>데이터 출처<ChevronRight size={12} /></button></div>
        </section>
        <section className="map-section" aria-label="지도와 자료 범위"><WalkingMap network={network} run={result?.run ?? run} normal={result?.normal ?? null} recommended={recommended} partialDetour={detour?.partial} selected={route?.type ?? "normal"} showForecast={showForecast} forecast={forecast} onToggleForecast={() => setShowForecast(value => !value)} onReplayRoute={showReplayRoute} origin={options.origin ?? undefined} destination={options.destination ?? undefined} step={step} recenterKey={recenterKey} selectionMode={selectionMode} onSelectCoordinate={coordinate => { if (selectionMode) point(coordinate, selectionMode); }} /><div className="map-insight"><div className="insight-icon"><Info size={22} /></div><div><span>OpenStreetMap 공개 원본</span><strong>{network.segments.length.toLocaleString()}개 구간 · {network.places.length.toLocaleString()}개 장소</strong><small>지도에서 ‘결빙 예상’을 켜고 확인할 시간대를 선택하세요.</small></div><button aria-label="데이터 출처 보기" onClick={() => setInfo(true)}><Info size={18} /></button></div></section>
      </div>}
      <footer className="page-footer"><span>빙빙제로 · 공개 데이터 기반 보행 길찾기</span><span>{network ? `지도 원본 기준 ${stamp(network.provenance.osmTimestamp)} KST` : '실제 원본 확인 중'}<button aria-label="자료 출처 상세" onClick={() => setInfo(true)}><Info size={13} /></button></span></footer>
    </main>
    <dialog ref={modal} className="info-dialog" aria-label="데이터 출처" onCancel={() => setInfo(false)} onClick={e => { if (e.target === e.currentTarget) setInfo(false); }}><div className="dialog-content"><div className="dialog-heading"><div className="dialog-brand"><Snowflake size={30} /><span>빙빙제로<small>공개 자료의 범위까지 정확하게.</small></span></div><button className="icon-button" aria-label="데이터 출처 닫기" onClick={() => setInfo(false)}><X size={22} /></button></div><span className="simulation-badge"><i />합성 데이터 없음</span><h2>실제 자료와 미확인 정보를<br />구분해서 보여드립니다.</h2>
      <div className="data-details"><h3>지금 연결된 자료</h3><dl><div><dt>보행망·장소</dt><dd>OpenStreetMap 보행망과 등록 장소를 사용합니다.{area === 'gwanak' && ' 서울대입구역 1~8번 출구는 역 관계와 출입구 태그를 대조했습니다.'}</dd></div>{network && <><div><dt>원본 기준</dt><dd>{stamp(network.provenance.osmTimestamp)} KST</dd></div><div><dt>수집 시각</dt><dd>{stamp(network.provenance.downloadedAt)} KST</dd></div><div><dt>출처·허가</dt><dd><a href={network.provenance.endpoint} target="_blank" rel="noreferrer">{network.provenance.source}</a> · <a href={network.provenance.licenseUrl} target="_blank" rel="noreferrer">{network.provenance.license}</a></dd></div></>}<div><dt>기상 자료</dt><dd>기상청의 500m 관측 기반 분석, 근시일 예보와 AWS 강수, Open-Meteo의 지역 예보를 사용합니다. 자료별 시각을 확인할 수 있습니다.</dd></div><div><dt>횡단보도</dt><dd>서울시가 공개한 2026년 8월 24일 시설 위치 {area === 'gangnam' ? gangnamCrossings.points.length : 68}곳을 표시합니다.</dd></div>{area === 'gwanak' && <div><dt>지정도로</dt><dd>행정안전부의 2026년 8월 11일 자료에서 관악구 현행 6건의 시점·종점을 표시합니다.</dd></div>}<div><dt>결빙 예상</dt><dd>기상과 추정 그늘, 공기에 노출된 보행 교량을 기준으로 주의구간을 계산합니다. 우회 경로는 일반 경로에 포함된 예상 주의구간을 모두 피할 수 있을 때 제공합니다.</dd></div></dl></div>
      <div className="info-principles"><h3>자료를 해석할 때</h3><p><strong>보행망</strong>은 공개 지도에 등록된 통행 정보를 기준으로 합니다. 지도에 누락된 출입 제한, 통제, 보도 상태는 미확인입니다.</p><p><strong>장소 연결점</strong>은 80m 이내의 실제 도로 노드입니다. 장소와 연결점 사이의 접근성과 소요시간은 미확인입니다.</p><p><strong>접근성</strong>은 공개 보행망에서 확인된 정보를 사용합니다. 경사·계단 조건을 켜면 해당 정보가 없는 구간도 제외합니다.</p><p><strong>위치정보</strong>는 보행 지도에서 브라우저 안에서 처리합니다. TMAP에서 검색·길찾기를 누르면 입력한 검색어나 선택한 두 위치가 TMAP에 전송됩니다. 앱은 이동 이력을 저장하지 않습니다. 기상 조회는 지역별 고정 좌표를 사용하며 배경지도 제공자는 요청 영역을 알 수 있습니다.</p></div>
      {network && <p className="source-downloads"><a href={area === 'gangnam' ? '/data/gangnam/osm.json' : '/data/osm.json'} download>지도 원본 JSON</a> · <a href={area === 'gangnam' ? '/data/gangnam/provenance.json' : '/data/provenance.json'} download>출처·검증 기록</a></p>}<button className="primary-button dialog-close" onClick={() => setInfo(false)}>확인했어요<Check size={18} /></button>
    </div></dialog>
  </div>;
}
