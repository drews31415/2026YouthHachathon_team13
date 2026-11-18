import { useEffect, useRef, useState } from 'react';
import { CloudSun, RefreshCw } from 'lucide-react';
import { fetchWeather, type WeatherSnapshot } from '../services/weather';

export default function LiveWeather() {
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function refresh() {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setLoading(true); setError(''); setWeather(null);
    try { setWeather(await fetchWeather(next.signal)); }
    catch (err) {
      if (next.signal.aborted) return;
      setError(err instanceof Error && err.name !== 'TimeoutError' && !(err instanceof TypeError) ? err.message : '기상정보 서버에 연결하지 못했습니다. 다시 시도해 주세요.');
    } finally { if (!next.signal.aborted) setLoading(false); }
  }
  const stamp = (value: string) => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(value));
  return <section className="live-weather" aria-label="실제 기상자료 조회" style={{ border: '1px solid #dfe7ee', borderRadius: 16, padding: 18, marginTop: 18 }}>
    <h3 style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 17, margin: '0 0 10px' }}><CloudSun size={20} /> 실제 기상자료 조회</h3>
    <p style={{ fontSize: 14, lineHeight: 1.65 }}>관악구청 주변의 기상 모델 자료입니다. 도로의 실제 결빙 관측값이 아니며 시연 경로에는 적용하지 않습니다.</p>
    <button type="button" onClick={refresh} disabled={loading} style={{ minHeight: 44, padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid #c6d4e5', borderRadius: 10, background: '#f3f7ff', color: '#164dbc', fontWeight: 700, cursor: 'pointer' }}><RefreshCw size={16} /> {loading ? '자료 조회 중…' : '기상자료 불러오기'}</button>
    <div aria-live="polite">
      {error && <p role="alert" style={{ color: '#a8322f', fontSize: 14 }}>{error}</p>}
      {weather && <div style={{ marginTop: 14, lineHeight: 1.8, fontSize: 14 }}>
        <strong style={{ fontSize: 22 }}>{weather.temperatureC.toFixed(1)}°C</strong>
        <div>지난 24시간 강수 {weather.precipitation24hMm === null ? '자료 부족' : `${weather.precipitation24hMm} mm`} · 강설 {weather.snowfall24hCm === null ? '자료 부족' : `${weather.snowfall24hCm} cm`}</div>
        <div>자료 기준 {stamp(weather.weatherTime)} (한국 시간)</div>
        <div>조회 시각 {stamp(weather.retrievedAt)} (한국 시간)</div>
        <small>예보 모델을 이용한 현재 기상값 · <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo.com</a></small>
      </div>}
    </div>
  </section>;
}
