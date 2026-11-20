import { useEffect, useId, useMemo, useState } from 'react';
import { estimateBuildingShade, liveShadingBuildings, surfaceShadeSource } from '../core/icing-forecast';
import type { Coordinate, Network } from '../core/types';
import {
  combineLiveForecast, fetchIcingHours, fetchIcingReplay, fetchKmaForecast, fetchKmaGrid, fetchNearbyPrecipitation, fetchPrecipitationObservations, fetchSeoulHours, forecastTemperature,
  hasRefreezeConditions, icingRainHistoryMs, icingReplays, icingWeatherMaxAgeMs, selectLiveIcingHour, summarizeIcingWeather,
  usesGridTemperature, withKmaGrid, withNearbyPrecipitation, readNearbyPrecipitation, type IcingArea, type IcingHour, type IcingReplay, type NearbyPrecipitation,
} from '../services/icing-weather';
import './icing-forecast.css';

export const forecastTime = (value: number, includeYear = false) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  year: includeYear ? 'numeric' : undefined,
}).format(value);

export function useIcingForecast(network: Network | null, enabled: boolean, area: IcingArea = 'gwanak',
  startReplay = false, initialGangnamScene: 'aifs' | 'gangnam' = 'aifs') {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchIcingHours>>>();
  const [dataArea, setDataArea] = useState<IcingArea>();
  const [failed, setFailed] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [selected, setSelected] = useState<number>();
  const [replayEnabled, setReplay] = useState(startReplay);
  const [gwanakScene, setGwanakScene] = useState<'original' | 'snow'>('original');
  const [gangnamScene, setGangnamScene] = useState(initialGangnamScene);
  const replayScene = area === 'gangnam' ? gangnamScene : gwanakScene;
  const [replayed, setReplayHour] = useState<{ scene: IcingReplay; hour: IcingHour }>();
  const [rain, setRain] = useState<NearbyPrecipitation[]>([]);
  const [rainHistory, setRainHistory] = useState<{ history?: unknown; seoul?: unknown }>({});
  const [supplementArea, setSupplementArea] = useState<IcingArea>();
  const [kma, setKma] = useState<Awaited<ReturnType<typeof fetchKmaForecast>>>();
  const [grid, setGrid] = useState<Awaited<ReturnType<typeof fetchKmaGrid>>>();
  const zones = network?.forecastZones;
  const city = !!zones;
  const replay = !city && replayEnabled;
  const [cityData, setCityData] = useState<{ zones: NonNullable<Network['forecastZones']>; hours: IcingHour[][]; retrievedAt: number }>();
  const [cityObservations, setCityObservations] = useState<{ zones: NonNullable<Network['forecastZones']>; payload: unknown }>();
  const [cityFailed, setCityFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !zones) return;
    const controller = new AbortController();
    const { signal } = controller;
    setCityFailed(false);
    const refresh = async () => {
      try {
        const points = zones.map(zone => zone.center);
        void fetchPrecipitationObservations(signal).then(payload => {
          if (!signal.aborted) setCityObservations({ zones, payload });
        }).catch(() => { /* City forecasts remain available during AWS delays. */ });
        const batches: Coordinate[][] = [];
        for (let i = 0; i < points.length; i += 20) batches.push(points.slice(i, i + 20));
        const responses = await Promise.allSettled(batches.map(batch => fetchSeoulHours(batch, signal)));
        signal.throwIfAborted();
        const retrievedAt = Date.now();
        const hours = responses.flatMap((response, i) => response.status === 'fulfilled' ? response.value.hours : batches[i].map(() => []));
        setClock(retrievedAt);
        setCityData({ zones, hours, retrievedAt });
        const enhanced = [...hours];
        for (let i = 0; i < points.length; i += 6) {
          await Promise.all(points.slice(i, i + 6).map(async (point, offset) => {
            const index = i + offset;
            const official = await fetchKmaForecast(signal, point).catch(() => undefined);
            enhanced[index] = combineLiveForecast(hours[index], official, Date.now());
          }));
          signal.throwIfAborted();
          setCityData(previous => previous?.retrievedAt === retrievedAt ? { ...previous, hours: [...enhanced] } : previous);
        }
        setCityFailed(!enhanced.some(items => items.length));
        // The 500 m analysis supplements weather near the freezing point.
        const cold = enhanced.flatMap((items, index) => items.some(hour => forecastTemperature(hour) <= 4) ? [index] : []);
        for (let i = 0; i < cold.length; i += 6) {
          await Promise.all(cold.slice(i, i + 6).map(async index => {
            const analysis = await fetchKmaGrid(signal, points[index]).catch(() => null);
            if (analysis?.status === 'ok') enhanced[index] = enhanced[index].map(hour => withKmaGrid(hour, analysis.rows, Date.now()));
          }));
          signal.throwIfAborted();
          setCityData(previous => previous?.retrievedAt === retrievedAt ? { ...previous, hours: [...enhanced] } : previous);
        }
      } catch {
        if (!signal.aborted) setCityFailed(true);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15 * 60_000);
    const tick = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => { controller.abort(); window.clearInterval(timer); window.clearInterval(tick); };
  }, [enabled, zones]);

  useEffect(() => {
    if (!enabled || city) return;
    const controller = new AbortController();
    setFailed(false);
    setKma(undefined); setGrid(undefined); setRain([]);
    if (replay) {
      void fetchIcingReplay(controller.signal, replayScene).then(hour => {
        if (!controller.signal.aborted) { setReplayHour({ scene: replayScene, hour }); setFailed(false); }
      }).catch(() => {
        if (!controller.signal.aborted) { setReplayHour(undefined); setFailed(true); }
      });
      return () => controller.abort();
    }
    setSupplementArea(area);
    const refreshForecast = async () => {
      try {
        const next = await fetchIcingHours(controller.signal, area);
        if (!controller.signal.aborted) { setData(next); setDataArea(area); setClock(Date.now()); setFailed(false); }
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
  }, [area, city, enabled, replay, replayScene]);

  const cityHours = useMemo(() => {
    if (!cityData || cityData.zones !== zones || clock - cityData.retrievedAt >= icingWeatherMaxAgeMs) return [];
    return cityData.hours.map((hours, index) => {
      const center = cityData.zones[index].center;
      const rain = cityObservations?.zones === cityData.zones
        ? readNearbyPrecipitation(cityObservations.payload, clock, center) : [];
      const history = [...readNearbyPrecipitation(rainHistory.history, clock, center, icingRainHistoryMs),
        ...readNearbyPrecipitation(rainHistory.seoul, clock, center, icingRainHistoryMs)];
      return new Map(hours.filter(hour => hour.time + 3_600_000 > clock).map(hour => [
        hour.time, withNearbyPrecipitation(hour, rain, clock, history),
      ]));
    });
  }, [cityData, cityObservations, rainHistory, zones, clock]);
  const hours = useMemo(() => {
    if (!enabled || replay) return [];
    if (city) {
      const byTime = new Map<number, IcingHour>();
      for (const zone of cityHours) for (const [time, hour] of zone) {
        if (!byTime.has(time)) byTime.set(time, hour);
      }
      return [...byTime.values()].sort((a, b) => a.time - b.time);
    }
    const regional = dataArea === area && data && clock - data.retrievedAt < icingWeatherMaxAgeMs ? data.hours : [];
    const history = [...readNearbyPrecipitation(rainHistory.history, clock, area, icingRainHistoryMs),
      ...readNearbyPrecipitation(rainHistory.seoul, clock, area, icingRainHistoryMs)];
    const areaMatches = supplementArea === area;
    return combineLiveForecast(regional, areaMatches ? kma : undefined, clock).map(hour =>
      withKmaGrid(withNearbyPrecipitation(hour, areaMatches ? rain : [], clock, history), areaMatches && grid?.status === 'ok' ? grid.rows : [], clock));
  }, [enabled, replay, city, cityHours, area, dataArea, data, supplementArea, kma, grid, rain, rainHistory, clock]);
  const mightUseRainHistory = (hour: IcingHour) => hour.time < clock + icingRainHistoryMs &&
    (forecastTemperature(hour) <= 0 || (hour.soilTemperatureC ?? Infinity) <= 0);
  const needsRainHistory = enabled && !replay && (city
    ? cityHours.some(zone => Array.from(zone.values()).some(mightUseRainHistory)) : hours.some(mightUseRainHistory));
  useEffect(() => {
    if (!needsRainHistory) return;
    const controller = new AbortController();
    const refresh = () => {
      for (const source of ['history', 'seoul'] as const) {
        void fetchPrecipitationObservations(controller.signal, source).then(packet => {
          if (packet && !controller.signal.aborted) { setRainHistory(previous => ({ ...previous, [source]: packet })); setClock(Date.now()); }
        }).catch(() => { /* Each source can supplement the forecast independently. */ });
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 15 * 60_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [needsRainHistory]);
  const active = useMemo(() => {
    if (!enabled || !network) return undefined;
    if (replay) return replayed?.scene === replayScene ? replayed.hour : undefined;
    return selectLiveIcingHour(hours, selected, clock);
  }, [enabled, replay, replayed, replayScene, hours, selected, clock, network]);
  const summaries = useMemo(() => new Map(hours.map(hour => [hour.time, summarizeIcingWeather(zones
    ? zones.map((_, index) => cityHours[index]?.get(hour.time)) : [hour])])), [hours, zones, cityHours]);
  const signals = active ? replay ? summarizeIcingWeather([active]) : summaries.get(active.time) : undefined;
  const shadeTime = signals?.refreeze ? active?.time : undefined;
  const expanded = !replay || replayScene !== 'original';
  const shade = useMemo(() => {
    if (!network || !active) return null;
    if (!zones) return shadeTime === undefined ? null : estimateBuildingShade(network, shadeTime, expanded);
    const completed = zones.flatMap((zone, index) => {
      const hour = cityHours[index]?.get(active.time);
      if (!hour || !hasRefreezeConditions(hour)) return [];
      return [estimateBuildingShade({ ...network, bounds: zone.bounds, segments: zone.segments, expandedShadingBuildings: zone.buildings }, hour.time, true)];
    });
    return completed.length ? { sunTooLow: completed.some(result => result.sunTooLow), sections: completed.flatMap(result => result.sections) } : null;
  }, [network, active, shadeTime, zones, cityHours, expanded]);
  const incomplete = signals?.incomplete ?? false;
  const buildingCount = useMemo(() => network ? liveShadingBuildings(network).length : 0, [network]);
  function changeMode(next: boolean) {
    if (next !== replay && !city) { setFailed(false); setClock(Date.now()); setReplay(next); }
  }
  function changeReplayScene(next: IcingReplay) {
    if (next === replayScene) return;
    setFailed(false);
    setReplayHour(undefined);
    if (next === 'aifs' || next === 'gangnam') setGangnamScene(next);
    else setGwanakScene(next);
  }
  const latestRain = !replay ? rain.find(record => record.time <= clock && clock - record.time < icingWeatherMaxAgeMs) : undefined;
  const aiModel = replay && replayScene === 'aifs' ? icingReplays.aifs.model : undefined;
  return { active, hours, summaries, signals, shade, failed: city ? cityFailed : failed, retrievedAt: city ? cityData?.retrievedAt : data?.retrievedAt, setSelected,
    replay, changeMode, replayScene, changeReplayScene, aiModel, expanded, latestRain, buildingCount, area, city, incomplete, gridStatus: grid?.status };
}

export function IcingForecastControl({ forecast, onReplayRoute }: {
  forecast: ReturnType<typeof useIcingForecast>;
  onReplayRoute: () => void;
}) {
  const selectId = useId();
  const sceneId = useId();
  const { active, hours, summaries, signals, shade, failed, setSelected, replay, changeMode,
    replayScene, changeReplayScene, area } = forecast;

  return <section className="icing-forecast-control" aria-label="결빙 예보 설정">
    {!forecast.city && <div className="icing-forecast-modes" role="group" aria-label="예보 조회 방식">
      <button type="button" aria-pressed={!replay} onClick={() => changeMode(false)}>최신 예보</button>
      <button type="button" aria-pressed={replay} onClick={() => changeMode(true)}>과거 예보로 비교</button>
    </div>}
    {replay && <label htmlFor={sceneId}>적용할 과거 예보
      <select id={sceneId} value={replayScene} onChange={e => changeReplayScene(e.target.value as IcingReplay)}>
        {area === 'gangnam' ? <>
          <option value="aifs">2월 2일 13시 · 양재역 AI 예보</option>
          <option value="gangnam">2월 2일 09시 · 말죽거리</option>
        </> : <>
          <option value="original">1월 27일 · 강수 뒤 재결빙</option>
          <option value="snow">1월 2일 · 녹은 눈 재결빙</option>
        </>}
      </select>
    </label>}
    {!replay && hours.length > 0 && <label htmlFor={selectId}>예상 시각 (한국 시간)
      <select id={selectId} value={active?.time ?? ''} onChange={e => setSelected(Number(e.target.value))}>
        {!active && <option value="" disabled>현재 시각 예보 없음</option>}
        {hours.map(hour => {
          const conditions = summaries.get(hour.time);
          const labels = [conditions?.freezingRain && '어는 비',
            (conditions?.refreeze || conditions?.lingeringRefreeze || conditions?.coldGround) && '재결빙 주의',
            conditions?.frost && '서리 주의'];
          return <option key={hour.time} value={hour.time}>{[forecastTime(hour.time), ...labels.filter(Boolean)].join(' · ')}</option>;
        })}
      </select>
    </label>}
    {!active ? <p role="status">{hours.length ? '다른 시각을 선택하면 해당 시간의 예보를 볼 수 있어요.'
      : failed ? '예보를 불러오지 못했어요.' : '예보를 확인하는 중…'}</p> : <>
      {replay && <p><strong>결빙 예상 기준 · {forecastTime(active.time, true)} KST</strong></p>}
      <p role="status">{forecast.city ? '서울 구간별 예보' : `기온 ${forecastTemperature(active)}°C`}{shade?.sections.length ? ' · 예상 주의구간 ' + shade.sections.length + '개'
        : signals?.refreeze ? ' · 지역 재결빙 주의' : ''}</p>
      {forecast.incomplete && <p role="status">재결빙 판단에 필요한 기상 자료가 부족해요.</p>}
      {signals?.freezingRain && <p className="icing-area-alert">어는 비·이슬비 예보가 있어요.</p>}
      {signals?.snowmelt && <p className="icing-area-alert">녹은 눈이 다시 얼 수 있어요.</p>}
      {signals?.lingeringRefreeze && <p className="icing-area-alert">비나 눈이 그친 뒤 추위가 이어져 얼음이 남아 있을 수 있어요.</p>}
      {signals?.coldGround && <p className="icing-area-alert">공기는 영상이지만 지표면이 0°C 이하로 예측돼 물기가 얼 수 있어요.</p>}
      {signals?.frost && <p className="icing-area-alert">서리가 생길 수 있어요.</p>}
      {replay && replayScene !== 'snow' && !!shade?.sections.length && <button type="button" className="icing-replay-route" onClick={onReplayRoute}>예시 출발지·목적지 불러오기</button>}
      <details className="icing-external-data"><summary>예보 출처</summary>
        <p>{forecast.aiModel ?? (forecast.city ? '구역별 기상청 및 Open-Meteo 자료' : usesGridTemperature(active) ? '기상청 500m 분석' : active.kma ? '기상청 예보' : 'Open-Meteo')}</p>
        <p><a href={replay ? icingReplays[replayScene].sourceUrl : 'https://open-meteo.com/en/docs'} target="_blank" rel="noreferrer">{replay ? '과거 예보 원본' : 'Open-Meteo 명세'}</a> · <a href={surfaceShadeSource.url} target="_blank" rel="noreferrer">Copernicus 30m</a></p>
        {!replay && <p><a href="https://data.seoul.go.kr/dataList/OA-23092/S/1/datasetView.do" target="_blank" rel="noreferrer">서울시 10분 강우량</a></p>}
        <small lang="en">{surfaceShadeSource.attribution}</small>
        <small lang="en">The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</small>
      </details>
    </>}
  </section>;
}
