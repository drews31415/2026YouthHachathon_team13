import { Footprints, Info, Navigation } from 'lucide-react';
import type { ForecastDetour } from '../core/engine';
import type { Route } from '../core/types';
import { hasFreezingRain } from '../services/icing-weather';
import { forecastTime, type useIcingForecast } from './IcingForecastControl';

interface Props {
  normal: Route;
  detour: ForecastDetour | null;
  forecast: ReturnType<typeof useIcingForecast>;
  forecastEnabled: boolean;
  selected: Route['type'];
  onSelect: (type: Route['type']) => void;
  onNavigate: () => void;
}

const distance = (m: number) => m >= 1000 ? (m / 1000).toFixed(2) + 'km' : Math.round(m) + 'm';

function time(seconds: number) {
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return (mins ? mins + '분' : '') + (rest || !mins ? (mins ? ' ' : '') + rest + '초' : '');
}

export function WalkingRouteResult({ normal, detour, forecast, forecastEnabled, selected, onSelect, onNavigate }: Props) {
  const alternate = detour?.route;
  const routes = alternate ? [alternate, normal] : [normal];
  const extra = alternate ? alternate.durationSeconds - normal.durationSeconds : 0;
  const alternateLabel = detour?.partial ? '결빙 일부 우회 경로' : '결빙 우회 경로';
  const unavailable = forecast.failed && !forecast.active;
  const finding = forecastEnabled && !forecast.active && !unavailable;
  const status = alternate ? detour?.partial ? '예상 주의구간을 일부 피해가요' : '예상 주의구간을 피해가요'
    : unavailable ? '결빙 예보를 불러오지 못했어요'
    : finding ? '결빙 예보를 확인하는 중…'
    : forecastEnabled && (detour?.crossings ?? 0) > 0 ? '주의구간을 피하는 경로를 찾지 못했어요'
    : forecastEnabled && forecast.shade?.sunTooLow ? '이 시각의 그늘은 평가되지 않았어요'
    : '';

  return <div className="flow-comparison">
    {forecast.replay && forecast.active && <p className="flow-route-date">과거 예보 기준 · {forecastTime(forecast.active.time, true)} KST</p>}
    <div className="flow-route-card" aria-label="경로 선택">
      {routes.map(route => {
        const recommended = route.type === 'recommended';
        const label = recommended ? alternateLabel : '일반 경로';
        return <button key={route.type} type="button" className={'flow-route-row ' + route.type}
          aria-pressed={selected === route.type} onClick={() => onSelect(route.type)}>
          <span className="flow-route-name">{recommended ? <Footprints size={21} aria-hidden="true" /> : <i aria-hidden="true" />}{label}</span>
          <strong>{time(route.durationSeconds)}</strong>
          <small>{distance(route.distanceM)}</small>
        </button>;
      })}
    </div>
    {extra > 0 && <div className="flow-extra">{time(extra)} 더 걸려요</div>}
    {status && <p className="flow-route-status" role="status">{status}</p>}
    {forecast.active && hasFreezingRain(forecast.active) && <p className="flow-route-status" role="status">이 지역에 어는 비 예보가 있어요</p>}
    <p className="flow-muted"><Info size={16} />실제 노면 상태와 다를 수 있어요</p>
    <button className="flow-primary" type="button" onClick={onNavigate}><Navigation size={22} />이 길로 안내 보기</button>
    {forecast.active && <details className="flow-result-details">
      <summary>경로 계산 상세</summary>
      {forecast.active && !forecast.replay && <p>결빙 예상 기준 · {forecastTime(forecast.active.time)} KST</p>}
      <p>일반 경로는 설정한 보행 조건에서 거리가 가장 짧은 경로예요.</p>
      {(detour?.crossings ?? 0) > 0 && <p>일반 경로가 예상 주의구간 {detour?.crossings}개를 지나요.</p>}
      <p>신호 대기와 보행망까지의 접근 시간은 제외돼요.</p>
    </details>}
  </div>;
}
