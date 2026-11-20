import { Footprints, Info, Navigation } from 'lucide-react';
import type { Route } from '../core/types';
import { icingReplays } from '../services/icing-weather';
import { forecastTime, type useIcingForecast } from './IcingForecastControl';

interface Props {
  route: Route | null;
  comparison: { normal: Route; warningCount: number } | null;
  forecast: ReturnType<typeof useIcingForecast>;
  onNavigate: () => void;
}

const distance = (m: number) => m >= 1000 ? (m / 1000).toFixed(2) + 'km' : Math.round(m) + 'm';

function time(seconds: number) {
  const rounded = Math.round(seconds);
  const mins = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return (mins ? mins + '분' : '') + (rest || !mins ? (mins ? ' ' : '') + rest + '초' : '');
}

export function WalkingRouteResult({ route, comparison, forecast, onNavigate }: Props) {
  const status = route ? ''
    : !forecast.active && forecast.hours.length ? '선택한 시각의 결빙 예보를 확인할 수 없어요. 예보·지도 설정에서 다른 시각을 골라 주세요.'
    : !forecast.active && forecast.failed ? '결빙 예보를 불러오지 못했어요'
    : !forecast.active ? '결빙 예보를 확인하는 중…'
    : forecast.incomplete ? '재결빙 판단에 필요한 기상 자료가 부족해요'
    : '결빙 예상구간과 지도에 등록된 계단·경사로를 모두 피하는 길을 찾지 못했어요';
  const finding = !forecast.active && !forecast.failed && !forecast.hours.length;
  const aiHour = forecast.aiModel ? forecast.active : undefined;

  return <>
    {forecast.active && <p className="flow-route-date">{forecast.replay ? '과거 예보' : '결빙 예상'} 기준 · {forecastTime(forecast.active.time, forecast.replay)} KST</p>}
    {aiHour && <section className="flow-ai-evidence" aria-label="AI 예보 근거">
      <p><strong>AI 예보 근거</strong> · {forecast.aiModel}</p>
      <p>기온 {aiHour.temperatureC.toFixed(1)}°C
        {aiHour.precedingPrecipMm !== null && <> · 직전 6시간 강수 {aiHour.precedingPrecipMm.toFixed(1)}mm</>}
        {aiHour.recentSnowfall && ' · 최근 강설 신호'}</p>
      <a href={icingReplays.aifs.sourceUrl} target="_blank" rel="noreferrer">과거 AI 예보 원본</a>
    </section>}
    {route ? <div className="flow-route-card">
      {comparison && <div className="flow-route-row flow-route-reference">
        <span className="flow-route-name"><span className="flow-route-key" aria-hidden="true" />일반 경로</span>
        <strong>{time(comparison.normal.durationSeconds)}</strong>
        <small>{distance(comparison.normal.distanceM)}</small>
      </div>}
      <div className="flow-route-row">
        <span className="flow-route-name">{comparison
          ? <><span className="flow-route-key" aria-hidden="true" />결빙 우회 경로</>
          : <><Footprints size={21} aria-hidden="true" />안내 경로</>}</span>
        <strong>{time(route.durationSeconds)}</strong>
        <small>{distance(route.distanceM)}</small>
      </div>
      {comparison && <p className="flow-route-difference">
        결빙 예상 주의구간 {comparison.warningCount}곳 회피 · {distance(route.distanceM - comparison.normal.distanceM)} 추가
      </p>}
    </div> : <div className="flow-route-status" role="status">
      {!finding && <strong>안내 가능한 경로 없음</strong>}
      <p>{status}</p>
    </div>}
    {forecast.shade?.sunTooLow && <p className="flow-route-status">태양 고도가 낮은 구간은 그늘을 평가하지 못했어요</p>}
    {forecast.signals?.freezingRain && <p className="flow-route-status">주변에 어는 비·이슬비 예보가 있어요</p>}
    {forecast.signals?.snowmelt ? <p className="flow-route-status">주변에서 녹은 눈이 다시 얼 수 있어요</p>
      : forecast.signals?.refreeze && route && <p className="flow-route-status">주변에 재결빙 조건이 있어요</p>}
    {forecast.signals?.lingeringRefreeze && <p className="flow-route-status">추위가 이어져 주변에 얼음이 남아 있을 수 있어요</p>}
    {forecast.signals?.coldGround && <p className="flow-route-status">지표면이 0°C 이하로 예측돼 주변의 물기가 얼 수 있어요</p>}
    {forecast.signals?.frost && <p className="flow-route-status">주변에 서리가 생길 수 있어요</p>}
    {route && <>
      <p className="flow-muted"><Info size={16} />지도에 기록된 위험을 피했어요. 실제 노면·계단·경사는 다를 수 있어요.</p>
      {route.steps.length > 0 && <button className="flow-primary" type="button" onClick={onNavigate}><Navigation size={22} />이 길로 안내 보기</button>}
      <details className="flow-result-details">
        <summary>경로 계산 상세</summary>
        <p>거리와 시간은 보행망 위 구간을 기준으로 계산했어요. 신호 대기는 시간에서 제외돼요.</p>
      </details>
    </>}
  </>;
}
