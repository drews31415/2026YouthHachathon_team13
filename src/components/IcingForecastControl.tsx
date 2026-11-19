import { useEffect, useId, useMemo, useState } from 'react';
import { estimateBuildingShade, sunPosition } from '../core/icing-forecast';
import type { Coordinate, Network } from '../core/types';
import { fetchIcingHours, hasRefreezeConditions, icingWeatherMaxAgeMs } from '../services/icing-weather';
import './icing-forecast.css';

export const forecastTime = (value: number) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(value);

export function useIcingForecast(network: Network, enabled: boolean) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchIcingHours>>>();
  const [failed, setFailed] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [selected, setSelected] = useState<number>();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await fetchIcingHours(controller.signal);
        if (!controller.signal.aborted) { setData(next); setClock(Date.now()); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) { setFailed(true); setClock(Date.now()); }
      }
    };
    setClock(Date.now());
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15 * 60_000);
    const tick = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); window.clearInterval(tick); };
  }, [enabled]);

  const hours = useMemo(() => enabled && data && clock - data.retrievedAt < icingWeatherMaxAgeMs
    ? data.hours.filter(hour => hour.time + 3600_000 > clock) : [], [enabled, data, clock]);
  const active = useMemo(() => {
    const [[west, south], [east, north]] = network.bounds;
    const center: Coordinate = [(west + east) / 2, (south + north) / 2];
    return hours.find(hour => hour.time === selected) ??
      hours.find(hour => hasRefreezeConditions(hour) && sunPosition(hour.time, center).up >= Math.sin(8 * Math.PI / 180)) ??
      hours.find(hasRefreezeConditions) ?? hours[0];
  }, [hours, selected, network.bounds]);
  const predicted = active ? hasRefreezeConditions(active) : false;
  const shade = useMemo(() => predicted && active ? estimateBuildingShade(network, active.time) : null, [network, active, predicted]);
  return { active, hours, shade, failed, retrievedAt: data?.retrievedAt, predicted, setSelected };
}

export function IcingForecastControl({ forecast }: { forecast: ReturnType<typeof useIcingForecast> }) {
  const selectId = useId();
  const { active, hours, predicted, shade, failed, retrievedAt, setSelected } = forecast;
  return <section className="icing-forecast-control" aria-label="결빙 예상구간">
    {!active ? <p role="status">{failed ? '사용할 수 있는 최신 예보가 없습니다.' : '공개 예보를 불러오는 중입니다.'}</p> : <>
      <label htmlFor={selectId}>예상 시각 (한국 시간)</label>
      <select id={selectId} value={active.time} onChange={e => setSelected(Number(e.target.value))}>
        {hours.map(hour => <option key={hour.time} value={hour.time}>{forecastTime(hour.time)}{hasRefreezeConditions(hour) ? ' · 재결빙 주의' : ''}</option>)}
      </select>
      <p role="status">지역 기온 {active.temperatureC}°C · 직전 6시간 강수 {active.precedingPrecipMm.toFixed(1)}mm</p>
      {predicted && shade?.sunTooLow ? <strong>지역 재결빙 주의 · 이 시각의 건물 그늘은 미평가</strong>
        : predicted && shade?.sections.length ? <strong>주황 점선 {shade.sections.length}곳 · 재결빙 예상 주의구간</strong>
        : predicted ? <strong>지역 재결빙 주의 · 확인한 보행선에 표시할 건물 그늘 없음</strong>
        : <strong>이 시각의 예보는 재결빙 표시 조건에 해당하지 않습니다.</strong>}
      <small>예상 범위 밖의 결빙 상태는 미확인입니다. 노면 실측 자료는 연결되지 않았습니다.</small>
      {retrievedAt !== undefined && <small><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo 예보</a> · {forecastTime(retrievedAt)} 조회 · OSM 건물 높이</small>}
    </>}
  </section>;
}
