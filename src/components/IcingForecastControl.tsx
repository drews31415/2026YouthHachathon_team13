import { useEffect, useId, useMemo, useState } from 'react';
import { estimateBuildingShade, liveShadingBuildings, surfaceShadeSource, sunPosition } from '../core/icing-forecast';
import type { Coordinate, Network } from '../core/types';
import { maljukgeoriHeatedWarnings } from '../gangnam-pilot';
import {
  combineLiveForecast, fetchIcingHours, fetchIcingReplay, fetchKmaForecast, fetchKmaGrid, fetchNearbyPrecipitation, forecastTemperature, hasFreezingRain,
  hasFrostConditions, hasRefreezeConditions, hasSnowmeltRefreeze, icingReplays, icingWeatherMaxAgeMs,
  usesGridTemperature, withKmaGrid, withNearbyPrecipitation, type IcingArea, type IcingHour, type IcingReplay, type NearbyPrecipitation,
} from '../services/icing-weather';
import './icing-forecast.css';

export const heatedWarningColor = '#937000';

export const forecastTime = (value: number, includeYear = false) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  year: includeYear ? 'numeric' : undefined,
}).format(value);

export function useIcingForecast(network: Network | null, enabled: boolean, area: IcingArea = 'gwanak', startReplay = false) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchIcingHours>>>();
  const [failed, setFailed] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [selected, setSelected] = useState<number>();
  const [replay, setReplay] = useState(startReplay);
  const [replayScene, setReplayScene] = useState<IcingReplay>(area === 'gangnam' ? 'gangnam' : 'original');
  const [replayHour, setReplayHour] = useState<IcingHour>();
  const [rain, setRain] = useState<NearbyPrecipitation[]>([]);
  const [kma, setKma] = useState<Awaited<ReturnType<typeof fetchKmaForecast>>>();
  const [grid, setGrid] = useState<Awaited<ReturnType<typeof fetchKmaGrid>>>();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    if (replay) {
      void fetchIcingReplay(controller.signal, replayScene).then(hour => {
        if (!controller.signal.aborted) { setReplayHour(hour); setFailed(false); }
      }).catch(() => {
        if (!controller.signal.aborted) { setReplayHour(undefined); setFailed(true); }
      });
      return () => controller.abort();
    }
    const refreshForecast = async () => {
      try {
        const next = await fetchIcingHours(controller.signal, area);
        if (!controller.signal.aborted) { setData(next); setClock(Date.now()); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) { setFailed(true); setClock(Date.now()); }
      }
    };
    const refresh = () => {
      void refreshForecast();
      void fetchKmaForecast(controller.signal, area).then(next => {
        if (!controller.signal.aborted) { setKma(next); setClock(Date.now()); }
      }).catch(() => { /* Open-Meteo remains available if KMA is delayed. */ });
      void fetchKmaGrid(controller.signal, area).then(next => {
        if (!controller.signal.aborted) { setGrid(next); setClock(Date.now()); }
      }).catch(() => {
        if (!controller.signal.aborted) { setGrid({ status: 'unavailable' }); setClock(Date.now()); }
      });
      void fetchNearbyPrecipitation(controller.signal, area).then(records => {
        if (!controller.signal.aborted) { setRain(records); setClock(Date.now()); }
      }).catch(() => { /* Regional forecast can still be used while the AWS is unavailable. */ });
    };
    setClock(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 15 * 60_000);
    const tick = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); window.clearInterval(tick); };
  }, [area, enabled, replay, replayScene]);

  const hours = useMemo(() => {
    if (!enabled || replay) return [];
    const regional = data && clock - data.retrievedAt < icingWeatherMaxAgeMs ? data.hours : [];
    return combineLiveForecast(regional, kma, clock).map(hour =>
      withKmaGrid(withNearbyPrecipitation(hour, rain, clock), grid?.status === 'ok' ? grid.rows : [], clock));
  }, [enabled, replay, data, kma, grid, rain, clock]);
  const active = useMemo(() => {
    if (!enabled || !network) return undefined;
    if (replay) return replayHour;
    const [[west, south], [east, north]] = network.bounds;
    const center: Coordinate = [(west + east) / 2, (south + north) / 2];
    return hours.find(hour => hour.time === selected) ??
      hours.find(hour => hasRefreezeConditions(hour) && sunPosition(hour.time, center).up >= Math.sin(8 * Math.PI / 180)) ??
      hours.find(hasFreezingRain) ?? hours.find(hasRefreezeConditions) ?? hours.find(hasFrostConditions) ?? hours[0];
  }, [enabled, replay, replayHour, hours, selected, network]);
  const predicted = active ? hasRefreezeConditions(active) : false;
  const shadeTime = predicted ? active?.time : undefined;
  const expanded = !replay || replayScene !== 'original';
  const shade = useMemo(() => network && shadeTime !== undefined ? estimateBuildingShade(network, shadeTime, expanded) : null, [network, shadeTime, expanded]);
  const heatedWarningSegments = useMemo(() => area === 'gangnam' && network && shade && active
    ? maljukgeoriHeatedWarnings(network, shade.sections, active) : new Set<string>(), [area, network, shade, active]);
  const buildingCount = useMemo(() => network ? liveShadingBuildings(network).length : 0, [network]);
  function changeMode(next: boolean) {
    if (next !== replay) { setFailed(false); setClock(Date.now()); setReplay(next); }
  }
  function changeReplayScene(next: IcingReplay) {
    if (next !== replayScene) { setFailed(false); setReplayHour(undefined); setReplayScene(next); }
  }
  const latestRain = !replay ? rain.find(record => record.time <= clock && clock - record.time < icingWeatherMaxAgeMs) : undefined;
  return { active, hours, shade, heatedWarningSegments, failed, retrievedAt: data?.retrievedAt, predicted, setSelected,
    replay, changeMode, replayScene, changeReplayScene, expanded, latestRain, buildingCount, area, gridStatus: grid?.status };
}

export function IcingForecastControl({ forecast, onReplayRoute, onFocusHeating }: {
  forecast: ReturnType<typeof useIcingForecast>;
  onReplayRoute: () => void;
  onFocusHeating: () => void;
}) {
  const selectId = useId();
  const sceneId = useId();
  const { active, hours, predicted, shade, failed, retrievedAt, setSelected, replay, changeMode,
    replayScene, changeReplayScene, expanded, latestRain, area, gridStatus } = forecast;
  const shownRain = active?.nearbyPrecipitation ?? latestRain;
  return <section className="icing-forecast-control" aria-label="결빙 예상구간">
    <div className="icing-forecast-modes" role="group" aria-label="예보 조회 방식">
      <button type="button" aria-pressed={!replay} onClick={() => changeMode(false)}>최신 예보</button>
      <button type="button" aria-pressed={replay} onClick={() => changeMode(true)}>과거 예보 시범</button>
    </div>
    {replay && area === 'gwanak' && <>
      <label htmlFor={sceneId}>과거 사례</label>
      <select id={sceneId} value={replayScene} onChange={e => changeReplayScene(e.target.value as IcingReplay)}>
        <option value="original">1월 27일 · 강수 뒤 재결빙</option>
        <option value="snow">1월 2일 · 녹은 눈 재결빙</option>
      </select>
    </>}
    {!active ? <p role="status">{failed ? '선택한 예보 자료를 불러오지 못했습니다.' : '공개 예보를 불러오는 중입니다.'}</p> : <>
      {replay ? <p><strong>{forecastTime(active.time, true)} KST · 과거 예보 시범</strong></p> : <>
        <label htmlFor={selectId}>예상 시각 (한국 시간)</label>
        <select id={selectId} value={active.time} onChange={e => setSelected(Number(e.target.value))}>
          {hours.map(hour => <option key={hour.time} value={hour.time}>{forecastTime(hour.time)}{hasFreezingRain(hour) ? ' · 어는 비' : hasRefreezeConditions(hour) ? ' · 재결빙 주의' : hasFrostConditions(hour) ? ' · 서리 주의' : ''}</option>)}
        </select>
      </>}
      <p role="status">{usesGridTemperature(active) ? '기상청 500m 분석' : active.kma ? '기상청 ' + (active.kma.kind === 'ultra' ? '초단기예보' : '단기예보') : 'Open-Meteo'} 기온 {forecastTemperature(active)}°C
        {active.precedingPrecipMm !== null && <> · 직전 6시간 강수 {active.precedingPrecipMm.toFixed(1)}mm</>}</p>
      {active.kma && <small><a href="https://apihub.kma.go.kr/apiList.do?seqApi=10" target="_blank" rel="noreferrer">기상청 예보</a> {forecastTime(active.kma.issuedAt)} 발표
        {active.kma.precipitation !== null && <> · 1시간 강수 {active.kma.precipitation}{/^\d+(?:\.\d+)?$/.test(active.kma.precipitation) ? 'mm' : ''}</>}
        {active.kma.humidity !== null && <> · 습도 {active.kma.humidity}%</>}</small>}
      {active.grid ? <p><a href="https://apihub.kma.go.kr/apiList.do?seqApi=971" target="_blank" rel="noreferrer">기상청 500m 분석</a> {forecastTime(active.grid.time)}{active.grid.snowDepthCm !== null && <> · 적설 {active.grid.snowDepthCm}cm</>}
        {active.grid.newSnow3hCm !== null && <> · 3시간 신적설 {active.grid.newSnow3hCm}cm</>}
        {active.gridMoisture && <> · 눈·강수 판단에 반영</>}</p>
        : !replay && gridStatus && gridStatus !== 'ok' && <small>기상청 500m 자료 {gridStatus === 'permission' ? '이용 권한 확인 필요' : '미수신'}</small>}
      {shownRain && <p>기상청 {shownRain.station} AWS {forecastTime(shownRain.time)} · 최근 1시간 강수 {shownRain.mm}mm
        {active.nearbyPrecipitation ? ' · 지역 강수 근거' : ''}</p>}
      {hasFreezingRain(active) && <p className="icing-area-alert"><strong>지역 예보에 어는 비·이슬비가 있습니다.</strong></p>}
      {hasSnowmeltRefreeze(active) && <p className="icing-area-alert"><strong>녹은 눈 재결빙 주의 · 앞선 12시간에 적설과 영상 기온 예보가 겹쳤습니다.</strong></p>}
      {hasFrostConditions(active) && <p className="icing-area-alert"><strong>동네 서리 주의 조건 · 약한 바람과 이슬점 근처 영하 기온</strong></p>}
      {predicted && shade?.sections.length ? <strong>재결빙 예상 주의구간 {shade.sections.length}개{shade.sunTooLow ? ' · 그늘 미평가' : ''}</strong>
        : predicted && shade?.sunTooLow ? <strong>지역 재결빙 주의 · 이 시각의 그늘은 미평가</strong>
        : predicted ? <strong>지역 재결빙 주의 · 확인한 보행선에 표시할 그늘 없음</strong>
        : <strong>이 시각의 예보는 재결빙 표시 조건에 해당하지 않습니다.</strong>}
      {forecast.heatedWarningSegments.size > 0 && <small className="heated-warning-key"><i aria-hidden="true" style={{ borderColor: heatedWarningColor }} />
        <button type="button" onClick={onFocusHeating}>열선 반영 주의 {forecast.heatedWarningSegments.size}개 보기</button> · 가동 미확인
      </small>}
      {replay ? <small>당시 지역 예보를 현재 지도 자료에 적용한 시범입니다. <a href={icingReplays[replayScene].sourceUrl} target="_blank" rel="noreferrer">과거 예보 출처</a></small>
        : <small>예상 범위 밖의 결빙 상태는 미확인입니다. 노면 실측 자료는 연결되지 않았습니다.</small>}
      {!replay && retrievedAt !== undefined && <small><a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">Open-Meteo 예보</a> · {forecastTime(retrievedAt)} 조회 · OSM 건물 높이</small>}
      {expanded && <details className="icing-external-data"><summary>눈·서리와 그늘 자료</summary>
        <small>지면 적설 예보 {active.snowDepthM === undefined ? '미수신' : (active.snowDepthM * 100).toFixed(1) + 'cm'} · 1시간 강설 {active.snowfallCm === undefined ? '미수신' : active.snowfallCm + 'cm'}</small>
        <small>이슬점 {active.dewPointC === undefined ? '미수신' : active.dewPointC + '°C'} · 풍속 {active.windKmh === undefined ? '미수신' : active.windKmh + 'km/h'} · 일사량 {active.solarWm2 === undefined ? '미수신' : active.solarWm2 + 'W/m²'}</small>
        <small>OSM 등록 높이 건물 {forecast.buildingCount}개 · <a href={surfaceShadeSource.url} target="_blank" rel="noreferrer">Copernicus 30m 표면 높이</a></small>
        <small lang="en">{surfaceShadeSource.attribution}</small>
        <small lang="en">The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</small>
      </details>}
      {replay && replayScene !== 'snow' && !!shade?.sections.length && <button type="button" className="icing-replay-route" onClick={onReplayRoute}>시범 우회 경로 보기</button>}
    </>}
    {!replay && <details className="icing-external-data"><summary>열선·제설 공개자료</summary>
      <small>{area === 'gwanak' && <><a href="https://map.seoul.go.kr/smgis2/short/6PGOy" target="_blank" rel="noreferrer">관악구 도로열선 설치 지도</a> · </>}<a href="https://doro.eseoul.go.kr/" target="_blank" rel="noreferrer">서울 주요 도로 제설상황판</a></small>
      <small><a href="https://data.seoul.go.kr/dataList/OA-22584/F/1/datasetView.do" target="_blank" rel="noreferrer">서울시 설치 목록</a> · 2026년 10월 1일 기준 {area === 'gangnam' ? '강남구 관리 77건' : '관악구 관리 46건'}</small>
      <small>보도별 열선 가동·제설 작업 이력은 미확인입니다.</small>
    </details>}
  </section>;
}
