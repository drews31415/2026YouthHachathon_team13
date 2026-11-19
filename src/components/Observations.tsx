import { useEffect, useState } from 'react';
import { RefreshCw, Thermometer } from 'lucide-react';
import LiveWeather from './LiveWeather';
import './observations.css';

interface Station {
  id: string | number;
  name: string;
  observedAt: string | null;
  lat: number;
  lon: number;
  temperature: number | null;
  humidity: number | null;
  rain12hMm?: number | null;
}
type Source = 'kma' | 'seoul';
interface ObservationSet {
  stations: Station[]; retrievedAt: string; source: string; retrievalMode?: string; historical?: boolean;
  missingStationIds?: (string | number)[];
}
interface Loaded { data: ObservationSet; captured: boolean }

const sources = {
  kma: { label: '기상청 방재기상관측', region: '관악구 인근 관측소', maxAge: 30 * 60_000,
    url: 'https://apihub.kma.go.kr/apiList.do?seqApi=2&seqApiSub=239' },
  seoul: { label: '서울시 S-DoT', region: '시범지역 안의 온습도 센서', maxAge: 2 * 60 * 60_000,
    url: 'https://data.seoul.go.kr/dataList/OA-22833/A/1/datasetView.do' },
};
const stamp = (s: string) => new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const metric = (n: unknown, unit: string) => typeof n === 'number' && Number.isFinite(n) ? n + unit : '미수신';

async function readObservation(url: string, signal: AbortSignal, expectedHash?: string): Promise<ObservationSet> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
  const raw = await response.arrayBuffer();
  if (expectedHash !== undefined) {
    const digest = await crypto.subtle.digest('SHA-256', raw);
    const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    if (hash !== expectedHash) throw new Error();
  }
  const data = JSON.parse(new TextDecoder().decode(raw));
  if (!Array.isArray(data.stations) || !data.stations.length || !Number.isFinite(Date.parse(data.retrievedAt))) throw new Error();
  for (const station of data.stations) {
    if (!station || !station.name || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) throw new Error();
    if (station.observedAt != null && !Number.isFinite(Date.parse(station.observedAt))) throw new Error();
    if ([station.temperature, station.humidity].some((n: unknown) => n != null && !Number.isFinite(n))) throw new Error();
  }
  return data;
}

function StationGroup({ provider, now }: { provider: Source; now: number }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refresh, setRefresh] = useState(0);
  const config = sources[provider];
  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setLoaded(null);
    async function load() {
      try {
        let captured = false, data: ObservationSet;
        try { data = await readObservation('/api/' + provider + '/weather', controller.signal); }
        catch {
          if (controller.signal.aborted) return;
          // The KMA server already tries its verified, time-limited capture.
          if (provider === 'kma') throw new Error();
          const proof = await fetch('/data/seoul-provenance.json', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
          if (!proof.ok) throw new Error();
          const { snapshotSha256 } = await proof.json();
          if (typeof snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotSha256)) throw new Error();
          data = await readObservation('/data/seoul-weather.json', controller.signal, snapshotSha256);
          captured = true;
        }
        if (!controller.signal.aborted) { setLoaded({ data, captured: captured || data.retrievalMode === 'captured' || data.historical === true }); setState('ready'); }
      } catch { if (!controller.signal.aborted) setState('error'); }
    }
    void load();
    return () => controller.abort();
  }, [provider, refresh]);
  useEffect(() => {
    const interval = window.setInterval(() => setRefresh(n => n + 1), 15 * 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const stations = loaded?.data.stations ?? [];
  const missing = loaded?.data.missingStationIds?.length ?? 0;
  const isFresh = (s: Station) => {
    const age = now - Date.parse(s.observedAt ?? '');
    return age >= -60_000 && age <= config.maxAge;
  };
  const fresh = stations.filter(s => isFresh(s) && typeof s.temperature === 'number');
  const displayed = provider === 'kma' ? stations.filter(isFresh) : stations;
  const freezing = fresh.filter(s => s.temperature! <= 0);
  const wetAndCold = freezing.filter(s => typeof s.rain12hMm === 'number' && s.rain12hMm > 0);
  return <section className="observation-source" aria-label={config.label}>
    <div className="observation-heading"><div><p>{config.region}</p><h3>{config.label}</h3></div>
      <button type="button" onClick={() => setRefresh(n => n + 1)} disabled={state === 'loading'} aria-label={config.label + ' 새로 조회'}><RefreshCw size={16} />새로 조회</button></div>
    <div aria-live="polite">
      {state === 'loading' && <p>관측자료를 조회하고 있습니다.</p>}
      {state === 'error' && <p>조회 가능한 관측자료가 없습니다.</p>}
      {loaded && <><p className="observation-status">{loaded.captured ? '실시간 조회 실패 · 저장된 관측 기록' : '공식 자료 조회'} · 수집 {stamp(loaded.data.retrievedAt)} KST</p>
        <p>{fresh.length ? '유효 시간 안에 기온이 측정된 지점 ' + fresh.length + '곳' : provider === 'kma' ? '30분 안에 들어온 관측이 없어 수치를 숨겼습니다.' : '유효 시간 안의 기온 자료가 없습니다. 아래 값은 관측 당시 기록입니다.'}</p>
        {missing > 0 && <p>이번 응답에 포함되지 않은 지점 {missing}곳</p>}
        {wetAndCold.length > 0 ? <p className="freeze-note">최근 12시간 강수와 0°C 이하 기온을 함께 기록한 지점은 {wetAndCold.map(s => s.name).join(', ')}입니다. 주변의 재결빙에 유의하세요.</p>
          : freezing.length > 0 && <p className="freeze-note">0°C 이하 기온을 기록한 지점은 {freezing.map(s => s.name).join(', ')}입니다. 젖은 노면은 얼 수 있습니다.</p>}
        {displayed.length > 0 && <div className="observation-scroll"><table><caption className="sr-only">지점별 관측값과 측정 시각 (한국 시간)</caption><thead><tr><th>지점</th><th>기온</th><th>습도</th>{provider === 'kma' && <th>12시간 강수</th>}<th>관측 시각</th></tr></thead>
        <tbody>{displayed.map(s => <tr key={s.id}><th scope="row">{s.name}</th><td>{metric(s.temperature, '°C')}</td><td>{metric(s.humidity, '%')}</td>{provider === 'kma' && <td>{metric(s.rain12hMm, ' mm')}</td>}<td>{s.observedAt ? <>{stamp(s.observedAt)}{!isFresh(s) && <small>지난 관측</small>}</> : '미수신'}</td></tr>)}</tbody></table></div>}
      </>}
    </div>
    <small>{provider === 'kma' ? '최근 관측 기준 30분. ' : '공개 표의 최근 1,000행을 설치 위치 9곳과 대조합니다. 최근 관측 기준 2시간. '}<a href={config.url} target="_blank" rel="noreferrer">{config.label} 원본</a></small>
  </section>;
}

export default function Observations() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return <section className="observations"><h2><Thermometer size={24} />동네 기상 관측</h2>
    <p>관악구 주변의 기온·습도와 강수 기록입니다. 골목별 노면 결빙은 현재 확인할 수 없습니다. 시각은 한국 시간입니다.</p>
    <div className="observation-grid"><StationGroup provider="kma" now={now} /><StationGroup provider="seoul" now={now} /></div>
    <LiveWeather />
  </section>;
}
