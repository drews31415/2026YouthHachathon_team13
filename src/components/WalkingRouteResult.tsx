import { ChevronRight, Footprints, Navigation, Snowflake } from 'lucide-react';
import type { ForecastDetour } from '../core/engine';
import type { Route } from '../core/types';
import { forecastTime, type useIcingForecast } from './IcingForecastControl';

interface Props {
  normal: Route;
  detour: ForecastDetour | null;
  forecast: ReturnType<typeof useIcingForecast>;
  forecastEnabled: boolean;
  selected: Route['type'];
  speed: number;
  onSelect: (type: Route['type']) => void;
  onNavigate: () => void;
}

const distance = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(2)}km` : `${Math.round(m)}m`;
function time(seconds: number) {
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  return mins ? `${mins}분 ${rounded % 60}초` : `${rounded}초`;
}

export function WalkingRouteResult({ normal, detour, forecast, forecastEnabled, selected, speed, onSelect, onNavigate }: Props) {
  const alternate = detour?.route;
  const heating = detour?.heatingComparison;
  const routes = alternate ? [normal, alternate] : [normal];
  const when = forecast.active ? forecastTime(forecast.active.time, forecast.replay) + ' KST' : '';
  const forecastStatus = !forecastEnabled ? '지도에서 ‘결빙 예상’을 켜면 우회 경로를 비교할 수 있습니다.'
    : !forecast.active ? forecast.failed ? '예보를 불러오지 못해 우회를 계산할 수 없습니다.' : '예보를 조회하는 중입니다.'
    : forecast.shade?.sunTooLow && !forecast.shade.sections.length ? '이 시각은 구간별 그늘 미평가로 우회 경로를 계산하지 않았습니다.'
    : !forecast.shade?.sections.length ? '선택한 시각에 표시 조건을 충족한 주의구간이 없습니다.'
    : !detour?.crossings ? '일반 경로는 선택한 시각의 예상 주의구간을 지나지 않습니다.'
    : detour.partial ? '모든 주의구간을 피할 수 없어 예상 결빙 노출을 줄인 대안을 표시했습니다.'
    : alternate ? `일반 경로가 예상 주의구간 ${detour.crossings}개를 지납니다.`
    : '현재 보행 설정과 지도 범위에서 표시 구간을 모두 피하는 경로를 찾지 못했습니다.';

  return <div className="walking-route-comparison">
    <div className="route-forecast-status">
      <strong><Snowflake size={16} />{forecast.replay ? '과거 예보 시범' : '결빙 예상구간 우회'}</strong>
      {!!when && <time dateTime={new Date(forecast.active!.time).toISOString()}>{when}</time>}
      <p>{forecastStatus}</p>
      {heating && <p>말죽거리 보도육교 열선 효과를 추정해 주의 점수에 반영했습니다. 점수가 낮을수록 예상 주의구간 노출이 적습니다.</p>}
    </div>
    {routes.map(route => {
      const score = route.type === 'normal' ? heating?.normal : heating?.alternate;
      return <button key={route.type} type="button" className={`route-card forecast-route ${route.type} ${selected === route.type ? 'selected' : ''}`}
        aria-pressed={selected === route.type} onClick={() => onSelect(route.type)}>
        <span className="route-card-top"><span className="route-title"><Footprints size={18} />{route.type === 'normal' ? '일반 보행 경로' : detour?.partial ? '주의구간 일부 우회 경로' : '예상구간 우회 경로'}</span></span>
        <span className="forecast-route-metrics"><strong>{time(route.durationSeconds)}</strong><span>{distance(route.distanceM)}</span></span>
        {score && (score.afterHeating < score.beforeHeating
          ? <span className="route-card-caption">열선 반영 전 {score.beforeHeating.toFixed(1)}점 · 반영 후 <strong>{score.afterHeating.toFixed(1)}점</strong></span>
          : <span className="route-card-caption">예상 주의 점수 {score.afterHeating.toFixed(1)}점</span>)}
        {route.type === 'recommended' && <span className="route-card-caption">일반 경로 대비 {distance(route.distanceM - normal.distanceM)} · {time(route.durationSeconds - normal.durationSeconds)} 추가</span>}
      </button>;
    })}
    <p className="inline-message">보행속도 {speed}m/s 기준 예상시간입니다. 신호 대기와 접근 공백은 제외됩니다. 보도별 실제 결빙 상태는 미확인입니다.</p>
    <button className="navigation-button" onClick={onNavigate}><Navigation size={18} />선택 경로 순서 살펴보기<ChevronRight size={18} /></button>
  </div>;
}
