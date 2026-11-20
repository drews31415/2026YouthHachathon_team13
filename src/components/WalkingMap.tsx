import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import { Maximize2, MousePointer2 } from 'lucide-react';
import type { Coordinate, ModelRun, Network, Place, Route, RouteStep, WalkSegment } from '../core/types';
import { IcingForecastControl, type useIcingForecast } from './IcingForecastControl';
import { forecastTemperature } from '../services/icing-weather';
import designated from '../designated-roads.json';
import gwanakCrossings from '../crossings.json';
import gangnamCrossings from '../gangnam-crossings.json';
import icingRegions from '../../icing-regions.json';
import './public-map-layers.css';

interface Props {
  network: Network;
  run: ModelRun;
  route: Route | null;
  comparisonRoute?: Route;
  stage: 'home' | 'search' | 'result' | 'guide';
  origin?: Place;
  destination?: Place;
  step?: RouteStep;
  recenterKey: number;
  onSelectCoordinate?: (coordinate: Coordinate) => void;
  selectionMode?: 'origin' | 'destination' | null;
  showForecast: boolean;
  forecast: ReturnType<typeof useIcingForecast>;
  onReplayRoute: () => void;
}

const latlngs = (coordinates: Coordinate[]) => coordinates.map(([lng, lat]) => [lat, lng] as L.LatLngTuple);
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

function segmentPopup(segment: WalkSegment) {
  const sourceUrl = 'https://www.openstreetmap.org/way/' + encodeURIComponent(segment.wayId);
  return '<div class="flow-map-popup"><strong>' + escape(segment.name) +
    '</strong><p>노면 상태 미확인</p><a href="' + sourceUrl + '" target="_blank" rel="noopener noreferrer">지도 원본</a></div>';
}

export function WalkingMap({ network, run, route, comparisonRoute, stage, origin, destination, step, recenterKey,
  onSelectCoordinate, selectionMode = null, showForecast, forecast, onReplayRoute }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const selection = useRef({ onSelectCoordinate, selectionMode });
  const [showCoverage, setShowCoverage] = useState(false);
  const [showDesignated, setShowDesignated] = useState(false);
  const [showCrossings, setShowCrossings] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  const gangnam = forecast.area === 'gangnam';
  const crossings = gangnam ? gangnamCrossings : gwanakCrossings;
  const areaLabel = forecast.city ? '서울' : icingRegions[forecast.area].label;
  selection.current = { onSelectCoordinate, selectionMode };

  function fitRoute() {
    const map = mapRef.current;
    if (!map) return;
    if (route?.coordinates.length) {
      const points = [...route.coordinates, ...(comparisonRoute?.coordinates ?? [])];
      map.fitBounds(L.latLngBounds(latlngs(points)), { paddingTopLeft: [37, 73], paddingBottomRight: [50, 62], maxZoom: 18 });
      return;
    }
    const endpoints = [origin, destination].filter((place): place is Place => !!place);
    if (endpoints.length) {
      map.fitBounds(L.latLngBounds(latlngs(endpoints.map(place => place.coordinate))), { padding: [60, 55], maxZoom: 17 });
      return;
    }
    const [[west, south], [east, north]] = network.bounds;
    map.fitBounds([[south, west], [north, east]], { padding: [20, 20] });
  }

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, minZoom: 5, maxZoom: 19, preferCanvas: true, renderer: L.canvas({ tolerance: 6 }) });
    mapRef.current = map;
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors', maxZoom: 19,
    }).addTo(map);
    tiles.on('tileerror', () => setTilesFailed(true));
    tiles.on('tileload', () => setTilesFailed(false));
    layers.current = L.layerGroup().addTo(map);
    map.createPane('icingForecast').style.zIndex = '450';
    const [[west, south], [east, north]] = network.bounds;
    map.fitBounds([[south, west], [north, east]], { padding: [48, 78] });
    map.on('click', event => {
      const { selectionMode: mode, onSelectCoordinate: onSelect } = selection.current;
      if (mode && onSelect) onSelect([event.latlng.lng, event.latlng.lat]);
    });
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(host.current);
    return () => { resize.disconnect(); map.remove(); mapRef.current = null; layers.current = null; };
  }, [network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (selectionMode) { map.closePopup(); map.getContainer().classList.add('coordinate-selection-active'); }
    else map.getContainer().classList.remove('coordinate-selection-active');
  }, [selectionMode]);

  useEffect(() => { mapRef.current?.closePopup(); }, [stage]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showDesignated || stage === 'home' || stage === 'guide') return;
    const markers = L.layerGroup().addTo(map);
    const points: L.LatLngTuple[] = [];
    for (const road of designated.records) {
      for (const [label, coords] of [['시점', road.start], ['종점', road.end]] as const) {
        const position: L.LatLngTuple = [coords[0], coords[1]];
        points.push(position);
        L.circleMarker(position, { pane: 'markerPane', radius: 8, color: '#663a00', fillColor: '#ffbb52', weight: 2, fillOpacity: .95, interactive: !selectionMode })
          .bindPopup('<strong>' + escape(road.name) + ' · ' + label + '</strong><p>' + escape(road.road) + '</p><p>행안부 상습결빙 지정도로의 ' + label + '입니다. 보도 적용 범위와 현재 결빙은 미확인입니다.</p>')
          .addTo(markers);
      }
    }
    if (!selectionMode) map.fitBounds(L.latLngBounds(points), { padding: [40, 70], maxZoom: 15 });
    return () => { markers.remove(); };
  }, [showDesignated, selectionMode, network, stage]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showCrossings || stage === 'home' || stage === 'guide') return;
    const markers = L.layerGroup().addTo(map);
    for (const point of crossings.points) {
      const popup = '<strong>' + escape(point.name) + '</strong><p>' + escape(point.crossingType) +
        ' · 보행등 ' + escape(point.pedestrianSignal) + '</p><small>서울시 횡단보도 관리번호 ' + escape(point.id) + '</small>';
      L.circleMarker([point.lat, point.lon], { pane: 'markerPane', radius: 6, color: '#004c59', fillColor: '#5ddbd3', weight: 2,
        fillOpacity: .95, interactive: !selectionMode, bubblingMouseEvents: false })
        .bindPopup(popup).addTo(markers);
    }
    return () => { markers.remove(); };
  }, [showCrossings, selectionMode, network, crossings, stage]);

  useEffect(() => {
    const map = mapRef.current;
    const hour = forecast.active;
    if (!map || !showForecast || !hour || !forecast.shade?.sections.length) return;
    const layer = L.layerGroup().addTo(map);
    const segments = new Map(network.segments.map(segment => [segment.id, segment]));
    for (const section of forecast.shade.sections) {
      const segment = segments.get(section.segmentId);
      if (!segment) continue;
      const line = L.polyline(latlngs(section.coordinates), {
        pane: 'icingForecast', color: '#1185dc', weight: 4, opacity: .94, dashArray: '3 6',
        interactive: !selectionMode, bubblingMouseEvents: false,
      }).addTo(layer);
      if (!selectionMode) line.bindPopup(
        '<div class="flow-map-popup"><strong>결빙 위험 예상</strong><p>' + escape(segment.name) +
        (forecast.city ? '' : ' · ' + escape(forecastTemperature(hour)) + '°C') + '</p></div>',
        { maxWidth: 200, minWidth: 120, closeButton: true },
      );
    }
    return () => { layer.remove(); };
  }, [showForecast, forecast.active, forecast.shade, forecast.city, selectionMode, network]);

  useEffect(() => {
    const map = mapRef.current;
    const sections = forecast.shade?.sections;
    if (!map || route || stage !== 'search' || !showForecast || !forecast.replay || !sections?.length) return;
    const points = sections.flatMap(section => latlngs(section.coordinates));
    map.fitBounds(L.latLngBounds(points), { maxZoom: 17, padding: [30, 35] });
  }, [network, route, stage, showForecast, forecast.replay, forecast.shade]);

  useEffect(() => {
    const group = layers.current;
    if (!group) return;
    group.clearLayers();
    const riskById = new Map(run.estimates.map(estimate => [estimate.segmentId, estimate]));
    const backgroundSegments = forecast.city && !showCoverage && !tilesFailed ? [] : network.segments;
    backgroundSegments.forEach(segment => {
      const points = latlngs(segment.coordinates);
      const missingSurface = riskById.get(segment.id)?.level === 'unknown';
      const line = L.polyline(points, {
        color: showCoverage && missingSurface ? '#8a7b9b' : '#748b94',
        weight: showCoverage && missingSurface ? 3 : 1.3,
        opacity: showCoverage && missingSurface ? .65 : tilesFailed ? .45 : .12,
        dashArray: showCoverage && missingSurface ? '3 6' : undefined,
        interactive: showCoverage && !selectionMode, bubblingMouseEvents: false,
      }).addTo(group);
      if (showCoverage && !selectionMode) line.bindPopup(() => segmentPopup(segment), { maxWidth: 200 });
    });

    if (comparisonRoute?.coordinates.length) {
      const points = latlngs(comparisonRoute.coordinates);
      L.polyline(points, { color: '#fff', weight: 8, opacity: .95, interactive: false }).addTo(group);
      L.polyline(points, { color: '#56657a', weight: 5, dashArray: '8 6', interactive: false }).addTo(group);
    }
    if (route?.coordinates.length) {
      const routeColor = '#0758ef';
      const points = latlngs(route.coordinates);
      L.polyline(points, { color: '#fff', weight: 12, opacity: .95, interactive: false }).addTo(group);
      L.polyline(points, { color: routeColor, weight: 8, lineJoin: 'round', interactive: false }).addTo(group);
      const start = route.coordinates[0];
      const finish = route.coordinates[route.coordinates.length - 1];
      L.circleMarker([start[1], start[0]], { radius: 5, weight: 2, color: '#fff', fillColor: routeColor, fillOpacity: 1, interactive: !selectionMode }).addTo(group)
        .bindTooltip('보행망 경로 시작점 · 장소까지의 접속로는 포함되지 않습니다.', { direction: 'top', className: 'endpoint-label' });
      L.circleMarker([finish[1], finish[0]], { radius: 5, weight: 2, color: '#fff', fillColor: routeColor, fillOpacity: 1, interactive: !selectionMode }).addTo(group)
        .bindTooltip('보행망 경로 끝점 · 장소까지의 접속로는 포함되지 않습니다.', { direction: 'top', className: 'endpoint-label' });
    }

    // Search exposes all registered places. Only selected endpoints are marked
    // so hundreds of source objects do not obscure the actual route.

    const endpoint = (place: Place, kind: 'origin' | 'destination') => {
      const label = kind === 'origin' ? '출발' : '도착';
      const icon = L.divIcon({ className: `endpoint-marker ${kind}-marker`, html: '<span></span>', iconSize: [28, 34], iconAnchor: [14, 31] });
      const connection = place.snapDistanceM > 1 ? ` · 보행망 연결점과 약 ${Math.round(place.snapDistanceM)}m 차이` : '';
      L.marker([place.coordinate[1], place.coordinate[0]], { icon, title: `${label}: ${place.name}${connection}`, interactive: !selectionMode }).addTo(group)
        .bindTooltip(escape(place.name), { direction: 'right', permanent: true, offset: [16, -20], className: 'endpoint-label' });
    };
    if (origin && stage !== 'guide') endpoint(origin, 'origin');
    if (destination) endpoint(destination, 'destination');
    if (step) {
      const icon = L.divIcon({ className: 'navigation-marker', html: '<span>▲</span>', iconSize: [42, 42], iconAnchor: [21, 21] });
      L.marker([step.coordinate[1], step.coordinate[0]], { icon, title: '선택한 경로 구간 · 실시간 위치가 아닙니다.', interactive: false }).addTo(group);
    }
  }, [network, run, route, comparisonRoute, origin, destination, showCoverage, step, selectionMode, stage, tilesFailed, forecast.city]);

  useEffect(() => {
    fitRoute();
  }, [route, comparisonRoute, recenterKey, network, stage, origin, destination]);

  useEffect(() => {
    if (step) mapRef.current?.panInside([step.coordinate[1], step.coordinate[0]], { padding: [42, 42] });
  }, [step]);

  const mapControls = stage === 'search' || stage === 'result';

  return <>
    <div className="map-wrapper real-data-map flow-map-canvas">
      <div className="walking-map" ref={host} role="region" aria-label={areaLabel + ' 보행 지도'} />
      {selectionMode && <div className="flow-map-selection" role="status"><MousePointer2 size={16} />지도에서 {selectionMode === 'origin' ? '출발' : '도착'} 위치를 선택하세요</div>}
      {mapControls && <button type="button" className="flow-map-fit" aria-label="경로 전체 보기" onClick={fitRoute}><Maximize2 size={20} /></button>}
      {tilesFailed && stage !== 'home' && <p className="flow-map-error" role="status">배경 지도 연결이 지연되고 있어요.</p>}
    </div>
    {mapControls && showForecast && <details className="flow-map-settings">
      <summary>예보·지도 설정</summary>
      <IcingForecastControl forecast={forecast} onReplayRoute={onReplayRoute} />
      {!forecast.city && <details className="flow-layer-settings">
        <summary>지도 표시 항목</summary>
        <label><input type="checkbox" checked={showCrossings} onChange={e => setShowCrossings(e.target.checked)} />횡단보도</label>
        {!gangnam && <label><input type="checkbox" checked={showDesignated} onChange={e => { if (!e.target.checked) fitRoute(); setShowDesignated(e.target.checked); }} />상습결빙 지정도로</label>}
        <label><input type="checkbox" checked={showCoverage} onChange={e => setShowCoverage(e.target.checked)} />노면 관측 미확인 구간</label>
      </details>}
    </details>}
  </>;
}
