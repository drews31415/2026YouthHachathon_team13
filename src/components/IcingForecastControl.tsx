import { useEffect, useId, useMemo, useState } from 'react';
import { estimateBuildingShade, liveShadingBuildings, surfaceShadeSource, sunPosition } from '../core/icing-forecast';
import type { Coordinate, Network } from '../core/types';
import { heatedWalkWarnings } from '../gangnam-pilot';
import {
  combineLiveForecast, fetchIcingHours, fetchIcingReplay, fetchKmaForecast, fetchKmaGrid, fetchNearbyPrecipitation, fetchPrecipitationObservations, fetchSeoulHours, forecastTemperature, hasFreezingRain,
  hasFrostConditions, hasRefreezeConditions, hasSnowmeltRefreeze, icingReplays, icingWeatherMaxAgeMs,
  usesGridTemperature, withKmaGrid, withNearbyPrecipitation, readNearbyPrecipitation, type IcingArea, type IcingHour, type IcingReplay, type NearbyPrecipitation,
} from '../services/icing-weather';
import './icing-forecast.css';

export const forecastTime = (value: number, includeYear = false) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  year: includeYear ? 'numeric' : undefined,
}).format(value);

export function useIcingForecast(network: Network | null, enabled: boolean, area: IcingArea = 'gwanak', startReplay = false) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchIcingHours>>>();
  const [dataArea, setDataArea] = useState<IcingArea>();
  const [failed, setFailed] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const [selected, setSelected] = useState<number>();
  const [replayEnabled, setReplay] = useState(startReplay);
  const [gwanakScene, setReplayScene] = useState<IcingReplay>('original');
  const replayScene = area === 'gangnam' ? 'gangnam' : gwanakScene;
  const [replayed, setReplayHour] = useState<{ scene: IcingReplay; hour: IcingHour }>();
  const [rain, setRain] = useState<NearbyPrecipitation[]>([]);
  const [kma, setKma] = useState<Awaited<ReturnType<typeof fetchKmaForecast>>>();
  const [grid, setGrid] = useState<Awaited<ReturnType<typeof fetchKmaGrid>>>();
  const zones = network?.forecastZones;
  const city = !!zones;
  const replay = !city && replayEnabled;
  const [cityData, setCityData] = useState<{ zones: NonNullable<Network['forecastZones']>; hours: IcingHour[][]; retrievedAt: number }>();
  const [cityFailed, setCityFailed] = useState(false);

  useEffect(() => {
    if (!enabled || !zones) return;
    const controller = new AbortController();
    const { signal } = controller;
    setCityFailed(false);
    const refresh = async () => {
      try {
        const points = zones.map(zone => zone.center);
        const observations = fetchPrecipitationObservations(signal).catch(() => null);
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
            const now = Date.now();
            const forecast = combineLiveForecast(hours[index], official, now);
            const rain = readNearbyPrecipitation(await observations, now, point);
            enhanced[index] = forecast.map(hour => withNearbyPrecipitation(hour, rain, now));
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
    return cityData.hours.map(hours => new Map(hours.filter(hour => hour.time + 3_600_000 > clock).map(hour => [
      hour.time, hour.nearbyPrecipitation && clock - hour.nearbyPrecipitation.time >= icingWeatherMaxAgeMs
        ? { ...hour, nearbyPrecipitation: undefined } : hour,
    ])));
  }, [cityData, zones, clock]);
  const hours = useMemo(() => {
    if (!enabled || replay) return [];
    if (city) {
      const byTime = new Map<number, IcingHour>();
      const severity = (hour: IcingHour) => hasFreezingRain(hour) ? 3 : hasRefreezeConditions(hour) ? 2 : hasFrostConditions(hour) ? 1 : 0;
      for (const zone of cityHours) for (const [time, hour] of zone) {
        const previous = byTime.get(time);
        if (!previous || severity(hour) > severity(previous)) byTime.set(time, hour);
      }
      return [...byTime.values()].sort((a, b) => a.time - b.time);
    }
    const regional = dataArea === area && data && clock - data.retrievedAt < icingWeatherMaxAgeMs ? data.hours : [];
    return combineLiveForecast(regional, kma, clock).map(hour =>
      withKmaGrid(withNearbyPrecipitation(hour, rain, clock), grid?.status === 'ok' ? grid.rows : [], clock));
  }, [enabled, replay, city, cityHours, area, dataArea, data, kma, grid, rain, clock]);
  const active = useMemo(() => {
    if (!enabled || !network) return undefined;
    if (replay) return replayed?.scene === replayScene ? replayed.hour : undefined;
    const [[west, south], [east, north]] = network.bounds;
    const center: Coordinate = [(west + east) / 2, (south + north) / 2];
    return hours.find(hour => hour.time === selected) ??
      hours.find(hour => hasRefreezeConditions(hour) && sunPosition(hour.time, center).up >= Math.sin(8 * Math.PI / 180)) ??
      hours.find(hasFreezingRain) ?? hours.find(hasRefreezeConditions) ?? hours.find(hasFrostConditions) ?? hours[0];
  }, [enabled, replay, replayed, replayScene, hours, selected, network]);
  const predicted = active ? hasRefreezeConditions(active) : false;
  const shadeTime = predicted ? active?.time : undefined;
  const expanded = !replay || replayScene !== 'original';
  const shade = useMemo(() => {
    if (!network || !active) return null;
    if (!zones) return shadeTime === undefined ? null : estimateBuildingShade(network, shadeTime, expanded);
    const completed = zones.flatMap((zone, index) => {
      const hour = cityHours[index]?.get(active.time);
      if (!hour || !hasRefreezeConditions(hour)) return [];
      return [estimateBuildingShade({ ...network, bounds: zone.bounds, segments: zone.segments, expandedShadingBuildings: zone.buildings }, hour.time, true)];
    });
    return completed.length ? { sunTooLow: completed.every(result => result.sunTooLow), sections: completed.flatMap(result => result.sections) } : null;
  }, [network, active, shadeTime, zones, cityHours, expanded]);
  const heatedWarningSegments = useMemo(() => {
    if (!network || !shade || !active) return new Set<string>();
    if (!zones) return heatedWalkWarnings(network, shade.sections, active);
    const bridgeZones = zones.flatMap((zone, index) => zone.segments.some(segment => segment.tags.bridge) ? [index] : []);
    const results = bridgeZones.flatMap(index => {
      const hour = cityHours[index]?.get(active.time);
      if (!hour) return [];
      return [...heatedWalkWarnings({ ...network, segments: zones[index].segments }, shade.sections, hour)];
    });
    return new Set(results);
  }, [network, zones, cityHours, shade, active]);
  const incomplete = city && !!active && (!zones || zones.some((_, i) => !cityHours[i]?.has(active.time)));
  const buildingCount = useMemo(() => network ? liveShadingBuildings(network).length : 0, [network]);
  function changeMode(next: boolean) {
    if (next !== replay && !city) { setFailed(false); setClock(Date.now()); setReplay(next); }
  }
  function changeReplayScene(next: IcingReplay) {
    if (next !== replayScene) { setFailed(false); setReplayHour(undefined); setReplayScene(next); }
  }
  const latestRain = !replay ? rain.find(record => record.time <= clock && clock - record.time < icingWeatherMaxAgeMs) : undefined;
  return { active, hours, shade, heatedWarningSegments, failed: city ? cityFailed : failed, retrievedAt: city ? cityData?.retrievedAt : data?.retrievedAt, predicted, setSelected,
    replay, changeMode, replayScene, changeReplayScene, expanded, latestRain, buildingCount, area, city, incomplete, gridStatus: grid?.status };
}

export function IcingForecastControl({ forecast, onReplayRoute }: {
  forecast: ReturnType<typeof useIcingForecast>;
  onReplayRoute: () => void;
}) {
  const selectId = useId();
  const sceneId = useId();
  const { active, hours, predicted, shade, failed, setSelected, replay, changeMode,
    replayScene, changeReplayScene, area } = forecast;

  return <section className="icing-forecast-control" aria-label="결빙 예보 설정">
    {!forecast.city && <div className="icing-forecast-modes" role="group" aria-label="예보 조회 방식">
      <button type="button" aria-pressed={!replay} onClick={() => changeMode(false)}>최신 예보</button>
      <button type="button" aria-pressed={replay} onClick={() => changeMode(true)}>과거 예보로 비교</button>
    </div>}
    {replay && area === 'gwanak' && <label htmlFor={sceneId}>적용할 과거 예보
      <select id={sceneId} value={replayScene} onChange={e => changeReplayScene(e.target.value as IcingReplay)}>
        <option value="original">1월 27일 · 강수 뒤 재결빙</option>
        <option value="snow">1월 2일 · 녹은 눈 재결빙</option>
      </select>
    </label>}
    {!active ? <p role="status">{failed ? '예보를 불러오지 못했어요.' : '예보를 확인하는 중…'}</p> : <>
      {replay ? <p><strong>결빙 예상 기준 · {forecastTime(active.time, true)} KST</strong></p>
        : <label htmlFor={selectId}>예상 시각 (한국 시간)
          <select id={selectId} value={active.time} onChange={e => setSelected(Number(e.target.value))}>
            {hours.map(hour => <option key={hour.time} value={hour.time}>{forecastTime(hour.time)}{hasFreezingRain(hour) ? ' · 어는 비' : hasRefreezeConditions(hour) ? ' · 재결빙 주의' : hasFrostConditions(hour) ? ' · 서리 주의' : ''}</option>)}
          </select>
        </label>}
      <p role="status">{forecast.city ? '서울 구간별 예보' : `기온 ${forecastTemperature(active)}°C`}{shade?.sections.length ? ' · 예상 주의구간 ' + shade.sections.length + '개'
        : predicted ? ' · 지역 재결빙 주의' : ''}</p>
      {forecast.incomplete && <p role="status">일부 구간의 예보를 받지 못했어요.</p>}
      {hasFreezingRain(active) && <p className="icing-area-alert">어는 비·이슬비 예보가 있어요.</p>}
      {hasSnowmeltRefreeze(active) && <p className="icing-area-alert">녹은 눈이 다시 얼 수 있어요.</p>}
      {hasFrostConditions(active) && <p className="icing-area-alert">서리가 생길 수 있어요.</p>}
      {replay && replayScene !== 'snow' && !!shade?.sections.length && <button type="button" className="icing-replay-route" onClick={onReplayRoute}>예시 출발지·목적지 불러오기</button>}
      <details className="icing-external-data"><summary>예보 출처</summary>
        <p>{usesGridTemperature(active) ? '기상청 500m 분석' : active.kma ? '기상청 예보' : 'Open-Meteo'}</p>
        <p><a href={replay ? icingReplays[replayScene].sourceUrl : 'https://open-meteo.com/en/docs'} target="_blank" rel="noreferrer">{replay ? '과거 예보 원본' : 'Open-Meteo 명세'}</a> · <a href={surfaceShadeSource.url} target="_blank" rel="noreferrer">Copernicus 30m</a></p>
        <small lang="en">{surfaceShadeSource.attribution}</small>
        <small lang="en">The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.</small>
      </details>
    </>}
  </section>;
}
