import { useEffect, useRef, useState } from 'react';
import { CloudSun, RefreshCw } from 'lucide-react';
import { fetchWeather, type WeatherSnapshot } from '../services/weather';

export default function LiveWeather() {
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(Date.now());
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    void refresh();
    const update = () => setCheckedAt(Date.now());
    const check = window.setInterval(update, 60_000);
    const renew = window.setInterval(() => void refresh(), 15 * 60_000);
    document.addEventListener('visibilitychange', update);
    return () => { controller.current?.abort(); window.clearInterval(check); window.clearInterval(renew); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    if (!weather) return;
    const deadline = Date.parse(weather.weatherTime) + 2 * 60 * 60_000;
    const expiry = window.setTimeout(() => setCheckedAt(Date.now()), Math.max(0, deadline - Date.now() + 1));
    return () => window.clearTimeout(expiry);
  }, [weather]);
  async function refresh() {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setLoading(true); setError(''); setWeather(null);
    try { const actual = await fetchWeather(next.signal); if (!next.signal.aborted) { setWeather(actual); setCheckedAt(Date.now()); } }
    catch (err) {
      if (next.signal.aborted) return;
      setError(err instanceof Error && err.name !== 'TimeoutError' && !(err instanceof TypeError) ? err.message : '기상정보 서버에 연결하지 못했습니다. 다시 시도해 주세요.');
    } finally { if (!next.signal.aborted) setLoading(false); }
  }
  const stamp = (value: string) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(value));
  const expired = weather !== null && checkedAt - Date.parse(weather.weatherTime) > 2 * 60 * 60_000;
  return <section className="live-weather" aria-label="공개 기상 모델 조회" style={{ border: '1px solid #dfe7ee', borderRadius: 16, padding: 18, marginTop: 18 }}>
    <h3 style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 17, margin: '0 0 10px' }}><CloudSun size={20} /> 공개 기상 모델</h3>
    <p style={{ fontSize: 14, lineHeight: 1.65 }}>관악구청 주변의 실제 제공 모델 자료입니다. 현장 실측·노면 결빙 관측이 아니므로 구간별 위험 점수로 바꾸지 않습니다.</p>
    <button type="button" onClick={refresh} disabled={loading} style={{ minHeight: 44, padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid #c6d4e5', borderRadius: 10, background: '#f3f7ff', color: '#164dbc', fontWeight: 700, cursor: 'pointer' }}><RefreshCw size={16} /> {loading ? '자료 조회 중…' : '기상자료 불러오기'}</button>
    <div aria-live="polite">
      {error && <p role="alert" style={{ color: '#a8322f', fontSize: 14 }}>{error}</p>}
      {expired && <p role="status">기상자료 기준 시각이 오래되어 수치를 숨겼습니다. 새로 조회해 주세요.</p>}
      {weather && !expired && <div style={{ marginTop: 14, lineHeight: 1.8, fontSize: 14 }}>
        {weather.retrievalMode === 'captured' && <p role="status" style={{ margin: '0 0 10px', padding: '8px 10px', borderRadius: 8, background: '#fff4dc', color: '#7b4d08', fontWeight: 700 }}>실시간 조회 실패 · 마지막 실제 수집본</p>}
        <strong style={{ fontSize: 22 }}>{weather.temperatureC.toFixed(1)}°C</strong>
        <div>최근 24개 정시 자료 합계: 강수 {weather.precipitation24hMm === null ? '자료 부족' : `${weather.precipitation24hMm} mm`} · 강설 {weather.snowfall24hCm === null ? '자료 부족' : `${weather.snowfall24hCm} cm`}</div>
        <div>집계 종료 {stamp(weather.periodEndedAt)} (한국 시간)</div>
        <div>자료 기준 {stamp(weather.weatherTime)} (한국 시간)</div>
        <div>{weather.retrievalMode === 'captured' ? '실제 수집 시각' : '조회 시각'} {stamp(weather.retrievedAt)} (한국 시간)</div>
        {weather.retrievalMode === 'captured' && <small>원본 해시와 출처를 확인한 수집본입니다. 자료 기준 시각이 2시간을 넘으면 표시하지 않습니다. <a href="/data/weather-provenance.json" target="_blank" rel="noreferrer">수집본 출처</a><br /></small>}
        <small>예보 모델이 제공한 기상값 · <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo.com</a></small>
      </div>}
    </div>
  </section>;
}
