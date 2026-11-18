import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Footprints, Info, LocateFixed, Map, Navigation, RotateCcw, Settings2, ShieldCheck, SlidersHorizontal, Snowflake, Sun, TriangleAlert, Type, Volume2, X } from 'lucide-react';
import { analyzeRisk, network, searchRoutes, nearestPlace, findPlaces } from './core/engine';
import type { Place, Route, Scenario, SearchOptions, SearchResult } from './core/types';
import { PlaceInput } from './components/PlaceInput';
import { WalkingMap } from './components/WalkingMap';
import LiveWeather from './components/LiveWeather';
import { expireResult } from './core/resultLifecycle';

const DEFAULT_OPTIONS: SearchOptions = { originId: 'snu-station', destinationId: 'gwanak-office', walkingSpeedMps: 1, avoidStairs: true, maxSlopePercent: null, scenario: 'freezing' };
const scenarios: { id: Scenario; name: string; description: string }[] = [
  { id: 'freezing', name: '눈 온 뒤 영하', description: '위험이 높은 구간을 피해가는 경로를 비교합니다.' },
  { id: 'dry', name: '온화하고 건조', description: '같은 길이 추천될 수 있는 조건을 확인합니다.' },
  { id: 'missing', name: '자료 부족', description: '정보가 없는 구간을 낮은 위험으로 판단하지 않습니다.' },
  { id: 'stale', name: '자료 만료', description: '갱신되지 않은 자료로 추천하지 않습니다.' },
  { id: 'blocked', name: '우회 경로 없음', description: '조건에 맞는 추천 경로가 없는 상황을 확인합니다.' },
];
const getPlace = (id: string) => network.places.find(place => place.id === id);
const distance = (meters: number) => meters >= 1000 ? `${(meters / 1000).toFixed(2)}km` : `${Math.round(meters)}m`;
const duration = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
const exactDuration = (seconds: number) => { const rounded = Math.round(seconds); return `${Math.floor(rounded / 60)}분 ${rounded % 60}초`; };
const time = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });

function RouteCard({ route, selected, extraSeconds, onClick }: { route: Route; selected: boolean; extraSeconds: number | null; onClick: () => void }) {
  const recommended = route.type === 'recommended';
  return <button type="button" className={`route-card ${recommended ? 'recommended' : 'normal'} ${selected ? 'selected' : ''}`} onClick={onClick} aria-pressed={selected}>
    <div className="route-card-top"><span className="route-title">{recommended ? <ShieldCheck size={18} /> : <Footprints size={18} />}{recommended ? '위험 회피 추천' : '일반 경로'}</span><span className="route-radio">{selected && <Check size={12} />}</span></div>
    <div className="route-card-metrics"><strong>{duration(route.durationSeconds)}<small>분</small></strong><span>{distance(route.distanceM)}</span>{recommended && extraSeconds !== null && <span className="extra-pill">{extraSeconds > 0 ? `+${exactDuration(extraSeconds)}` : '추가 시간 없음'}</span>}</div>
    <div className="route-card-caption">{recommended ? <><span className="green-dot" />높은 위험·정보 부족 구간 제외</> : <><span className={route.highRiskCount || route.unknownCount ? 'amber-dot' : 'neutral-dot'} />{route.highRiskCount ? `위험 높음 ${route.highRiskCount}개 구간 포함` : route.unknownCount ? `정보 부족 ${route.unknownCount}개 구간 포함` : '거리 기준으로 짧은 경로'}</>}</div>
  </button>;
}

export default function App() {
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_OPTIONS);
  const [originQuery, setOriginQuery] = useState(getPlace(DEFAULT_OPTIONS.originId)?.name ?? '');
  const [destinationQuery, setDestinationQuery] = useState(getPlace(DEFAULT_OPTIONS.destinationId)?.name ?? '');
  const [result, setResult] = useState<SearchResult>(() => searchRoutes(DEFAULT_OPTIONS));
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<'normal' | 'recommended'>('recommended');
  const [error, setError] = useState('');
  const [locationMessage, setLocationMessage] = useState('');
  const [locating, setLocating] = useState(false);
  const [preferences, setPreferences] = useState(false);
  const [demoSettings, setDemoSettings] = useState(false);
  const [info, setInfo] = useState(false);
  const [largeText, setLargeText] = useState(() => { try { return localStorage.getItem('bbzr-large-text') === 'true'; } catch { return false; } });
  const [navigation, setNavigation] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [recenterKey, setRecenterKey] = useState(0);
  const timer = useRef<number | null>(null);
  const serial = useRef(0);
  const modalRef = useRef<HTMLDialogElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const infoButton = useRef<HTMLButtonElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const run = useMemo(() => dirty ? analyzeRisk(options.scenario) : result.run, [dirty, options.scenario, result.run]);
  const origin = getPlace(options.originId);
  const destination = getPlace(options.destinationId);
  const activeRoute = selected === 'recommended' ? result.recommended : result.normal;
  const currentStep = navigation ? activeRoute?.steps[stepIndex] : undefined;
  const highCount = run.estimates.filter(estimate => estimate.level === 'high').length;
  const unknownCount = run.estimates.filter(estimate => estimate.level === 'unknown').length;
  const remainingSteps = activeRoute?.steps.slice(stepIndex) ?? [];
  const remainingMeters = remainingSteps.reduce((total, step) => total + step.distanceM, 0);
  const remainingSeconds = remainingSteps.reduce((total, step) => total + step.durationSeconds, 0);

  useEffect(() => { try { localStorage.setItem('bbzr-large-text', String(largeText)); } catch { /* Preference persistence is optional. */ } }, [largeText]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); window.speechSynthesis?.cancel(); }, []);
  useEffect(() => { if (info) modalRef.current?.showModal(); else if (modalRef.current?.open) modalRef.current.close(); }, [info]);
  useEffect(() => { if (demoSettings) settingsRef.current?.showModal(); else if (settingsRef.current?.open) settingsRef.current.close(); }, [demoSettings]);
  useEffect(() => {
    const check = () => {
      const next = expireResult(result);
      if (next !== result) { setResult(next); setNavigation(false); window.speechSynthesis?.cancel(); }
    };
    if (result.status === 'stale-data') return;
    const timeout = window.setTimeout(check, Math.max(0, Date.parse(result.run.validUntil) - Date.now()));
    document.addEventListener('visibilitychange', check);
    return () => { window.clearTimeout(timeout); document.removeEventListener('visibilitychange', check); };
  }, [result]);

  function invalidate(next: Partial<SearchOptions>) {
    window.speechSynthesis?.cancel();
    serial.current += 1;
    if (timer.current) window.clearTimeout(timer.current);
    setLoading(false); setOptions(old => ({ ...old, ...next })); setDirty(true); setNavigation(false); setError('');
  }
  function selectPlace(kind: 'origin' | 'destination', place: Place) {
    if (kind === 'origin') { setOriginQuery(place.name); invalidate({ originId: place.id }); }
    else { setDestinationQuery(place.name); invalidate({ destinationId: place.id }); }
    setLocationMessage('');
  }
  function calculate(next: SearchOptions = options) {
    window.speechSynthesis?.cancel();
    const originId = next.originId || findPlaces(originQuery).find(place => place.name === originQuery.trim())?.id || '';
    const destinationId = next.destinationId || findPlaces(destinationQuery).find(place => place.name === destinationQuery.trim())?.id || '';
    if (!originId || !destinationId) { setError('검색 결과에서 출발지와 목적지를 선택해 주세요. 시연 생활권의 장소만 조회할 수 있어요.'); return; }
    const requested = { ...next, originId, destinationId };
    setOptions(requested); setLoading(true); setError(''); setNavigation(false);
    const requestSerial = ++serial.current;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (serial.current !== requestSerial) return;
      const response = searchRoutes(requested);
      setResult(response); setDirty(false); setLoading(false); setSelected(response.recommended ? 'recommended' : 'normal'); setStepIndex(0); setRecenterKey(key => key + 1);
      window.setTimeout(() => resultsHeading.current?.focus({ preventScroll: true }), 0);
    }, 180);
  }
  function swap() {
    setOriginQuery(destinationQuery); setDestinationQuery(originQuery);
    invalidate({ originId: options.destinationId, destinationId: options.originId }); setLocationMessage('');
  }
  function locate() {
    setLocationMessage('');
    if (!navigator.geolocation) { setLocationMessage('이 브라우저는 현재 위치를 지원하지 않아요. 출발지를 직접 선택해 주세요.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(position => {
      setLocating(false);
      const [longitude, latitude] = [position.coords.longitude, position.coords.latitude];
      const place = nearestPlace([longitude, latitude]);
      if (!place) { setLocationMessage('현재 위치는 시연 장소와 거리가 멀어요. 관악구 생활권의 출발지를 직접 선택해 주세요.'); return; }
      selectPlace('origin', place);
      setLocationMessage(`가까운 시연 장소인 ${place.name}(으)로 출발지를 설정했어요. 현재 위치에서 그 장소까지의 길은 포함하지 않아요.`);
    }, failure => {
      setLocating(false);
      setLocationMessage(failure.code === 1 ? '위치 접근이 허용되지 않았어요. 출발지를 직접 선택해 주세요.' : '현재 위치를 가져오지 못했어요. 다시 시도하거나 출발지를 선택해 주세요.');
    }, { timeout: 10000, maximumAge: 30000, enableHighAccuracy: false });
  }
  function chooseScenario(scenario: Scenario) { const next = { ...options, scenario }; setOptions(next); calculate(next); }
  function startNavigation() {
    const checked = expireResult(result);
    if (checked !== result) { setResult(checked); return; }
    if (dirty || !activeRoute) return;
    setNavigation(true); setStepIndex(0);
  }
  function endNavigation() { setNavigation(false); setStepIndex(0); window.speechSynthesis?.cancel(); }
  function speak() {
    if (!currentStep || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const speech = new SpeechSynthesisUtterance(`${currentStep.instruction}. ${Math.round(currentStep.distanceM)}미터 이동합니다. 시연 안내입니다.`);
    speech.lang = 'ko-KR'; speech.rate = .85; window.speechSynthesis.speak(speech);
  }
  function closeInfo() { setInfo(false); infoButton.current?.focus(); }

  return <div className={`app-shell ${largeText ? 'large-text' : ''}`}>
    <a className="skip-link" href="#route-search">경로 검색으로 바로가기</a>
    <aside className="side-rail" aria-label="주 메뉴">
      <a className="rail-brand" href="#route-search" aria-label="빙빙제로 경로 찾기"><Snowflake size={32} strokeWidth={2.3} /><span>빙빙제로</span></a>
      <div className="rail-divider" />
      <a className="rail-item active" href="#route-search"><Map size={23} /><span>길찾기</span></a>
      <button type="button" className={`rail-item ${demoSettings ? 'is-open' : ''}`} aria-expanded={demoSettings} onClick={() => setDemoSettings(!demoSettings)}><SlidersHorizontal size={22} /><span>시연 설정</span></button>
      <div className="rail-bottom"><button type="button" className="rail-item" ref={infoButton} onClick={() => setInfo(true)}><Info size={22} /><span>서비스 안내</span></button><span className="rail-beta">BETA 0.1</span></div>
    </aside>

    <main className="workspace">
      <header className="page-header">
        <div className="header-heading"><span className="mobile-brand"><Snowflake size={23} />빙빙제로</span><span className="header-eyebrow">A LITTLE CARE, EVERY STEP</span><h1>겨울에도, 한 걸음 편안하게<span>.</span></h1><p>결빙 위험을 살피고, 나에게 맞는 길을 선택하세요.</p></div>
        <div className="header-actions"><span className="simulation-badge"><i />시뮬레이션</span><button type="button" className={`text-toggle ${largeText ? 'active' : ''}`} aria-pressed={largeText} onClick={() => setLargeText(!largeText)}><Type size={18} /><span>큰 글씨</span></button><button type="button" className="mobile-info" aria-label="서비스 안내" onClick={() => setInfo(true)}><Info size={20} /></button></div>
      </header>

      <div className="main-layout">
        <section className="planner" aria-label="보행 경로 계획">
          {!navigation ? <>
            <form className="search-section" id="route-search" onSubmit={event => { event.preventDefault(); calculate(); }}>
              <div className="section-heading"><h2>어디로 걸어가세요?</h2><span className="walking-label"><Footprints size={15} />도보</span></div>
              <div className="place-fields">
                <PlaceInput label="출발지" kind="origin" value={originQuery} onChange={value => { setOriginQuery(value); invalidate({ originId: '' }); }} onSelect={place => selectPlace('origin', place)} />
                <div className="field-divider" />
                <PlaceInput label="목적지" kind="destination" value={destinationQuery} onChange={value => { setDestinationQuery(value); invalidate({ destinationId: '' }); }} onSelect={place => selectPlace('destination', place)} />
                <button type="button" className="swap-button" onClick={swap} aria-label="출발지와 목적지 바꾸기"><ArrowUpDown size={18} /></button>
              </div>
              <div className="search-secondary"><button type="button" className="location-button" onClick={locate} disabled={locating}><LocateFixed size={16} />{locating ? '현재 위치 확인 중…' : '현재 위치를 출발지로'}</button><button type="button" className={`preferences-button ${preferences ? 'active' : ''}`} aria-expanded={preferences} onClick={() => setPreferences(!preferences)}><Settings2 size={16} />보행 설정<ChevronDown size={14} /></button></div>
              {locationMessage && <p className="inline-message" role="status">{locationMessage}</p>}
              {preferences && <div className="preferences-panel">
                <label className="speed-label" htmlFor="walking-speed">나의 보행 속도<select id="walking-speed" value={options.walkingSpeedMps} onChange={event => invalidate({ walkingSpeedMps: Number(event.target.value) })}><option value={.8}>천천히 · 초당 0.8m</option><option value={1}>여유롭게 · 초당 1.0m</option><option value={1.2}>보통 · 초당 1.2m</option></select></label>
                <label className="check-row"><input type="checkbox" checked={options.avoidStairs} onChange={event => invalidate({ avoidStairs: event.target.checked })} /><span>계단이 있는 길 제외</span></label>
                <label className="check-row"><input type="checkbox" checked={options.maxSlopePercent === 5} onChange={event => invalidate({ maxSlopePercent: event.target.checked ? 5 : null })} /><span>경사 5% 초과 구간 제외</span></label>
                <small>접근성 조건이 확인되지 않은 구간도 제외합니다. 휠체어 통행 적합성을 보장하지 않습니다.</small>
              </div>}
              {error && <p className="inline-error" role="alert"><TriangleAlert size={16} />{error}</p>}
              <button type="submit" className="primary-button search-button" disabled={loading}><Footprints size={20} />{loading ? '경로를 살펴보고 있어요…' : '경로 찾기'}{!loading && <ArrowRight size={19} />}</button>
            </form>

            <section className="results-section" aria-label="경로 비교" aria-live="polite">
              <div className="section-heading"><h2 ref={resultsHeading} tabIndex={-1}>내게 맞는 길 선택</h2><span className="result-context">{dirty ? '입력 변경됨' : '시연 결과'}</span></div>
              {dirty ? <div className="empty-result"><div className="empty-icon"><Footprints size={27} /></div><strong>새로운 길을 살펴볼까요?</strong><p>입력한 장소와 보행 설정으로<br />경로를 다시 찾아주세요.</p><button type="button" className="text-button" onClick={() => calculate()}>변경한 조건으로 찾기 <ArrowRight size={15} /></button></div> : <>
                {result.status !== 'ok' && <div className={`result-notice ${result.status === 'no-recommendation' ? 'warning' : ''}`} role="status"><TriangleAlert size={19} /><div><strong>{result.status === 'insufficient-data' ? '위험을 판단할 자료가 부족해요' : result.status === 'stale-data' ? '위험 정보의 유효시간이 지났어요' : result.status === 'no-recommendation' ? '조건에 맞는 우회 경로가 없어요' : result.status === 'invalid-input' ? '출발지와 목적지를 확인해 주세요' : '경로를 찾지 못했어요'}</strong><p>{result.message}</p></div></div>}
                <div className="route-card-list">
                  {result.recommended && <RouteCard route={result.recommended} selected={selected === 'recommended'} extraSeconds={result.extraSeconds} onClick={() => setSelected('recommended')} />}
                  {result.normal && <RouteCard route={result.normal} selected={selected === 'normal'} extraSeconds={null} onClick={() => setSelected('normal')} />}
                </div>
                {result.extraSeconds !== null && result.normal && result.recommended && <div className="comparison-note"><Clock3 size={15} /><p>{result.extraSeconds > 0 ? <><strong>{exactDuration(result.extraSeconds)} 더 걸려요.</strong> 높은 위험 구간을 피해 이동해요.</> : <><strong>추가로 걸리는 시간은 없어요.</strong> 두 경로가 같을 수 있어요.</>}</p></div>}
                {activeRoute && <button type="button" className="navigation-button" onClick={startNavigation}><Navigation size={18} />선택한 경로 따라보기<ChevronRight size={18} /></button>}
              </>}
              <div className="safety-note"><Info size={15} /><p>실제 노면 상태와 다를 수 있어요.<br />이동할 때는 주변 길을 함께 확인해 주세요.</p></div>
            </section>
          </> : <section className="navigation-section" aria-label="경로 따라보기">
            <button type="button" className="back-button" onClick={endNavigation}><ArrowLeft size={17} />경로 비교로</button>
            <div className="navigation-heading"><span className="eyebrow">WALK THROUGH</span><h2>{destination?.name}까지<br />한 구간씩 살펴보세요.</h2><span className="demo-nav-pill">시연 안내 · GPS 실시간 안내 아님</span></div>
            {currentStep && <>
              <div className="direction-card"><Navigation size={33} /><span>{currentStep.instruction}</span><strong>{distance(currentStep.distanceM)}<small>{currentStep.name}</small></strong></div>
              <div className="remaining-stats"><span><Clock3 size={18} /><strong>{duration(remainingSeconds)}분</strong>남음</span><span><Footprints size={18} /><strong>{distance(remainingMeters)}</strong>남음</span></div>
              {'speechSynthesis' in window && <button type="button" className="voice-button" onClick={speak}><Volume2 size={17} />이 구간 안내 듣기</button>}
              <div className="step-progress"><span>구간 {stepIndex + 1} / {activeRoute?.steps.length}</span><div><i style={{ width: `${((stepIndex + 1) / (activeRoute?.steps.length || 1)) * 100}%` }} /></div></div>
              <div className="step-buttons"><button type="button" disabled={!stepIndex} onClick={() => { window.speechSynthesis?.cancel(); setStepIndex(index => index - 1); }}><ChevronLeft size={18} />이전 구간</button><button type="button" className="primary-button" onClick={() => { window.speechSynthesis?.cancel(); if (stepIndex < (activeRoute?.steps.length ?? 1) - 1) setStepIndex(index => index + 1); else endNavigation(); }}>{stepIndex < (activeRoute?.steps.length ?? 1) - 1 ? '다음 구간' : '따라보기 완료'}<ChevronRight size={18} /></button></div>
              <ol className="route-steps">{activeRoute?.steps.map((step, index) => <li key={`${step.segmentId}-${index}`} className={index === stepIndex ? 'current' : index < stepIndex ? 'passed' : ''}><button type="button" onClick={() => { window.speechSynthesis?.cancel(); setStepIndex(index); }} aria-current={index === stepIndex ? 'step' : undefined}><span className="step-number">{index < stepIndex ? <Check size={12} /> : index + 1}</span><span><strong>{step.name}</strong><small>{step.instruction} · {distance(step.distanceM)}</small></span></button></li>)}</ol>
              <button type="button" className="end-navigation" onClick={endNavigation}>따라보기 종료</button>
            </>}
          </section>}

          <div className="planner-footer"><span><Snowflake size={14} />차가운 날, 신중한 한 걸음.</span><button type="button" onClick={() => setInfo(true)}>데이터 안내 <ChevronRight size={12} /></button></div>
        </section>

        <section className="map-section" aria-label="지도와 위험 정보">
          <WalkingMap network={network} run={run} normal={dirty ? null : result.normal} recommended={dirty ? null : result.recommended} selected={selected} origin={origin} destination={destination} step={currentStep} recenterKey={recenterKey} />
          <div className="weather-card"><div className="weather-icon">{options.scenario === 'dry' ? <Sun size={29} /> : <Snowflake size={29} />}</div><div><span>시연 기상 조건</span><strong>{run.temperatureC === null ? '자료 없음' : `${run.temperatureC}°`}<small>{options.scenario === 'dry' ? '온화하고 건조' : options.scenario === 'missing' ? '정보 부족' : options.scenario === 'stale' ? '유효시간 만료' : '눈 온 뒤 영하'}</small></strong></div><button type="button" aria-label="시연 기상 조건 변경" onClick={() => setDemoSettings(!demoSettings)}><SlidersHorizontal size={17} /></button></div>
          <div className="map-insight"><div className="insight-icon">{unknownCount ? <Info size={20} /> : <Snowflake size={22} />}</div><div><span>{unknownCount ? '정보가 부족한 구간을 확인하세요' : highCount ? '길 위의 위험을 미리 살펴보세요' : '현재 시연 조건은 온화해요'}</span><strong>{highCount ? `위험 높음 ${highCount}개 구간` : '높은 위험 없음'}{unknownCount > 0 && ` · 정보 부족 ${unknownCount}개`}</strong><small>합성 보행망 · 규칙 기반 시뮬레이션</small></div><button type="button" aria-label="위험 정보 설명 보기" onClick={() => setInfo(true)}><Info size={18} /></button></div>
          <button type="button" className="mobile-demo-button" onClick={() => setDemoSettings(!demoSettings)}><SlidersHorizontal size={16} />시연 설정</button>
        </section>
      </div>

      <footer className="page-footer"><span>빙빙제로 <span className="footer-dot">·</span> 보행자를 위한 겨울 길찾기</span><span>시연 데이터 기준 {time(run.analyzedAt)} (KST)<button type="button" onClick={() => setInfo(true)} aria-label="분석 시점과 데이터 상세 보기"><Info size={13} /></button></span></footer>
    </main>

    <dialog ref={settingsRef} className="demo-drawer" aria-label="시연 설정" onCancel={() => setDemoSettings(false)} onClick={event => { if (event.target === event.currentTarget) setDemoSettings(false); }}><div className="drawer-heading"><div><span className="eyebrow">TRY THE SCENARIOS</span><h2>다른 겨울을 살펴보세요</h2></div><button type="button" className="icon-button" onClick={() => setDemoSettings(false)} aria-label="시연 설정 닫기"><X size={21} /></button></div><p className="drawer-intro">기상 조건에 따라 위험과 추천 경로가 어떻게 바뀌는지 확인해 보세요. 모든 조건은 시연용입니다.</p><div className="scenario-options">{scenarios.map(scenario => <button type="button" key={scenario.id} className={options.scenario === scenario.id ? 'selected' : ''} aria-pressed={options.scenario === scenario.id} onClick={() => chooseScenario(scenario.id)}><span className="scenario-radio">{options.scenario === scenario.id && <Check size={12} />}</span><span><strong>{scenario.name}</strong><small>{scenario.description}</small></span></button>)}</div><div className="drawer-data-note"><Info size={17} /><p>합성 구간과 기상 조건으로 경로 계산을 검증하는 시제품입니다. 실제 결빙 관측·예측 결과로 사용하지 마세요.</p></div><LiveWeather /><button type="button" className="reset-demo" onClick={() => { setOriginQuery(getPlace(DEFAULT_OPTIONS.originId)?.name ?? ''); setDestinationQuery(getPlace(DEFAULT_OPTIONS.destinationId)?.name ?? ''); setLocationMessage(''); calculate(DEFAULT_OPTIONS); }}><RotateCcw size={16} />기본 시연으로 돌아가기</button></dialog>

    <dialog ref={modalRef} className="info-dialog" aria-label="서비스 안내" onCancel={() => setInfo(false)} onClick={event => { if (event.target === event.currentTarget) closeInfo(); }}>
      <div className="dialog-content"><div className="dialog-heading"><div className="dialog-brand"><Snowflake size={30} /><span>빙빙제로<small>한 걸음, 더 신중하게.</small></span></div><button type="button" className="icon-button" onClick={closeInfo} aria-label="서비스 안내 닫기"><X size={22} /></button></div><span className="simulation-badge"><i />시뮬레이션 시제품</span><h2>위험 정보와 이동시간을<br />함께 보고 선택하세요.</h2><p className="dialog-intro">빙빙제로는 결빙 위험이 높게 예상되는 구간을 피한 보행 경로와 일반 경로를 비교합니다. 현재 버전은 실제 노면을 확인하거나 안전을 보장하지 않습니다.</p><div className="data-details"><h3>지금 보이는 데이터</h3><dl><div><dt>보행망</dt><dd>{network.source}</dd></div><div><dt>위험 추정</dt><dd>합성 기상·환경 값 기반 규칙 모형<br />{run.version} · 학습된 AI 아님</dd></div><div><dt>분석 시각</dt><dd>{new Date(run.analyzedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} KST</dd></div><div><dt>유효시간</dt><dd>{new Date(run.validUntil).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} KST</dd></div><div><dt>배경 지도</dt><dd><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap 기여자</a> · 합성 경로와 실제 도로는 다를 수 있습니다.</dd></div></dl></div><div className="info-principles"><h3>이렇게 계산해요</h3><p><strong>위험 회피 추천</strong>은 위험 높음과 정보 부족 구간을 제외합니다. 선택한 계단·경사 조건은 두 경로에 동일하게 적용합니다.</p><p><strong>추가 소요시간</strong>은 같은 보행속도로 계산한 추천 경로 시간에서 일반 경로 시간을 뺀 값입니다. 분 단위 표시는 올림하므로 카드 숫자의 차이와 다를 수 있습니다.</p><p><strong>보행약자 접근성</strong>은 현장 검증 전입니다. 계단과 경사 외의 보도 폭, 턱, 공사 등은 충분히 반영하지 못합니다.</p><p><strong>개인정보</strong>는 필요한 순간에만 사용합니다. 현재 위치는 가까운 시연 출발지를 찾는 데만 쓰며 이동 이력을 저장하지 않습니다. 지도 제공자는 요청 IP와 지도 영역을 알 수 있습니다.</p></div><button type="button" className="primary-button dialog-close" onClick={closeInfo}>확인했어요 <Check size={18} /></button></div>
    </dialog>
  </div>;
}
