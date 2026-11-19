import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import { Layers3, LocateFixed, Minus, Plus, MapPin, Maximize2, MousePointer2, Info } from 'lucide-react';
import type { Coordinate, ModelRun, Network, Place, Route, RouteStep, WalkSegment } from '../core/types';
import designated from '../designated-roads.json';
import crossings from '../crossings.json';
import './public-map-layers.css';

interface Props {
  network: Network;
  run: ModelRun;
  normal: Route | null;
  recommended: Route | null;
  selected: 'normal' | 'recommended';
  origin?: Place;
  destination?: Place;
  step?: RouteStep;
  recenterKey: number;
  onSelectCoordinate?: (coordinate: Coordinate) => void;
  selectionMode?: 'origin' | 'destination' | null;
}

const latlngs = (coordinates: Coordinate[]) => coordinates.map(([lng, lat]) => [lat, lng] as L.LatLngTuple);
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

function segmentPopup(segment: WalkSegment) {
  const tags = Object.entries(segment.tags).filter(([key]) => ['highway', 'foot', 'access', 'sidewalk', 'incline', 'wheelchair', 'surface', 'oneway:foot'].includes(key));
  const sourceUrl = `https://www.openstreetmap.org/way/${encodeURIComponent(segment.wayId)}`;
  return `<div class="risk-popup real-segment-popup"><span>실제 OpenStreetMap 보행망 구간</span><strong>${escape(segment.name)}</strong><dl><div><dt>구간 거리</dt><dd>${Math.round(segment.lengthM)}m</dd></div><div><dt>계단</dt><dd>${segment.stairs === true ? '계단 태그 있음' : segment.stairs === false ? '계단 아님 태그 확인' : '자료 미기재'}</dd></div><div><dt>경사</dt><dd>${segment.slope === null ? '자료 미기재' : `${escape(segment.slope)}%`}</dd></div><div><dt>노면 결빙</dt><dd>관측자료 없음 · 판단 불가</dd></div></dl>${tags.length ? `<div class="osm-tags">${tags.map(([key, value]) => `<code>${escape(key)}=${escape(value)}</code>`).join('')}</div>` : ''}<a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">OSM 원본 way ${escape(segment.wayId)} ↗</a><small>자료 미기재를 통행 가능·위험 낮음으로 해석하지 않습니다.</small></div>`;
}

export function WalkingMap({ network, run, normal, recommended, selected, origin, destination, step, recenterKey, onSelectCoordinate, selectionMode = null }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const selection = useRef({ onSelectCoordinate, selectionMode });
  const [showCoverage, setShowCoverage] = useState(false);
  const [showDesignated, setShowDesignated] = useState(false);
  const [showCrossings, setShowCrossings] = useState(false);
  const [layerMenu, setLayerMenu] = useState(false);
  const [tilesFailed, setTilesFailed] = useState(false);
  selection.current = { onSelectCoordinate, selectionMode };

  function fitNetwork() {
    const [[west, south], [east, north]] = network.bounds;
    mapRef.current?.fitBounds([[south, west], [north, east]], { padding: [48, 78] });
  }

  function fitRoute() {
    const route = selected === 'recommended' ? recommended : normal;
    if (route?.coordinates.length) mapRef.current?.fitBounds(L.latLngBounds(latlngs(route.coordinates)), { padding: [65, 85], maxZoom: 18 });
    else fitNetwork();
  }

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: true, minZoom: 12, maxZoom: 19, preferCanvas: true, renderer: L.canvas({ tolerance: 6 }) });
    mapRef.current = map;
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors', maxZoom: 19,
    }).addTo(map);
    tiles.on('tileerror', () => setTilesFailed(true));
    tiles.on('tileload', () => setTilesFailed(false));
    layers.current = L.layerGroup().addTo(map);
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showDesignated) return;
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
  }, [showDesignated, selectionMode, network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showCrossings) return;
    const markers = L.layerGroup().addTo(map);
    for (const point of crossings.points) {
      const popup = '<strong>' + escape(point.name) + '</strong><p>' + escape(point.crossingType) +
        ' · 보행등 ' + escape(point.pedestrianSignal) + '</p><small>서울시 횡단보도 관리번호 ' + escape(point.id) + '</small>';
      L.circleMarker([point.lat, point.lon], { pane: 'markerPane', radius: 6, color: '#004c59', fillColor: '#5ddbd3', weight: 2,
        fillOpacity: .95, interactive: !selectionMode, bubblingMouseEvents: false })
        .bindPopup(popup).addTo(markers);
    }
    return () => { markers.remove(); };
  }, [showCrossings, selectionMode, network]);

  useEffect(() => {
    const group = layers.current;
    if (!group) return;
    group.clearLayers();
    const riskById = new Map(run.estimates.map(estimate => [estimate.segmentId, estimate]));
    network.segments.forEach(segment => {
      const points = latlngs(segment.coordinates);
      const missingSurface = riskById.get(segment.id)?.level === 'unknown';
      const line = L.polyline(points, {
        color: showCoverage && missingSurface ? '#8a7b9b' : '#748b94',
        weight: showCoverage && missingSurface ? 3 : 1.3,
        opacity: showCoverage && missingSurface ? .65 : .3,
        dashArray: showCoverage && missingSurface ? '3 6' : undefined,
        interactive: !selectionMode, bubblingMouseEvents: false,
      }).addTo(group);
      if (!selectionMode) line.bindPopup(() => segmentPopup(segment), { maxWidth: 280 });
    });

    const routeLine = (route: Route, active: boolean) => {
      const points = latlngs(route.coordinates);
      if (active) L.polyline(points, { color: '#fff', weight: 10, opacity: .95, interactive: false }).addTo(group);
      L.polyline(points, { color: active ? '#1765ef' : '#8e9da9', weight: active ? 6 : 3.5, opacity: active ? 1 : .65, dashArray: active ? undefined : '7 8', lineJoin: 'round', interactive: false }).addTo(group);
      if (active && route.coordinates.length) {
        const start = route.coordinates[0];
        const finish = route.coordinates[route.coordinates.length - 1];
        L.circleMarker([start[1], start[0]], { radius: 5, weight: 2, color: '#fff', fillColor: '#1765ef', fillOpacity: 1, interactive: !selectionMode }).addTo(group)
          .bindTooltip('보행망 경로 시작점 · 장소까지의 접속로는 포함되지 않습니다.', { direction: 'top', className: 'endpoint-label' });
        L.circleMarker([finish[1], finish[0]], { radius: 5, weight: 2, color: '#fff', fillColor: '#1765ef', fillOpacity: 1, interactive: !selectionMode }).addTo(group)
          .bindTooltip('보행망 경로 끝점 · 장소까지의 접속로는 포함되지 않습니다.', { direction: 'top', className: 'endpoint-label' });
      }
    };
    const inactive = selected === 'recommended' ? normal : recommended;
    const active = selected === 'recommended' ? recommended : normal;
    if (inactive) routeLine(inactive, false);
    if (active) routeLine(active, true);

    // Search exposes all registered places. Only selected endpoints are marked
    // so hundreds of source objects do not obscure the actual route.

    const endpoint = (place: Place, kind: 'origin' | 'destination') => {
      const label = kind === 'origin' ? '출발' : '도착';
      const icon = L.divIcon({ className: `endpoint-marker ${kind}-marker`, html: `<span>${label}</span>`, iconSize: [40, 40], iconAnchor: [20, 20] });
      const connection = place.snapDistanceM > 1 ? ` · 보행망 연결점과 약 ${Math.round(place.snapDistanceM)}m 차이` : '';
      L.marker([place.coordinate[1], place.coordinate[0]], { icon, title: `${label}: ${place.name}${connection}`, interactive: !selectionMode }).addTo(group)
        .bindTooltip(escape(place.name), { direction: 'right', permanent: true, offset: [22, 0], className: 'endpoint-label' });
    };
    if (origin) endpoint(origin, 'origin');
    if (destination) endpoint(destination, 'destination');
    if (step) {
      const icon = L.divIcon({ className: 'navigation-marker', html: '<span>▲</span>', iconSize: [42, 42], iconAnchor: [21, 21] });
      L.marker([step.coordinate[1], step.coordinate[0]], { icon, title: '선택한 경로 구간 · 실시간 위치가 아닙니다.', interactive: false }).addTo(group);
    }
  }, [network, run, normal, recommended, selected, origin, destination, showCoverage, step, selectionMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const route = selected === 'recommended' ? recommended : normal;
    if (route?.coordinates.length) map.fitBounds(L.latLngBounds(latlngs(route.coordinates)), { paddingTopLeft: [65, 90], paddingBottomRight: [95, 90], maxZoom: 18, animate: true });
    else { const [[west, south], [east, north]] = network.bounds; map.fitBounds([[south, west], [north, east]], { padding: [48, 78], animate: true }); }
  }, [normal, recommended, selected, recenterKey, network]);

  return <div className="map-wrapper real-data-map">
    <div className="walking-map" ref={host} role="region" aria-label="관악구 실제 OpenStreetMap 보행망. 노면 결빙 관측자료는 확보되지 않았습니다." />
    <div className="map-topline"><span className="area-chip"><span className="live-dot" /><MapPin size={14} />서울 관악구<span className="area-chip-sub">실제 OSM 보행망</span></span><span className="map-source-tag">공개 지도 자료</span></div>
    {selectionMode && <div className="map-selection-notice" role="status"><MousePointer2 size={17} /><span>지도를 눌러 <strong>{selectionMode === 'origin' ? '출발 위치' : '도착 위치'}</strong>를 선택하세요.</span></div>}
    <div className="map-tools">
      <button type="button" title="공공자료 표시" aria-label="공공자료 표시" aria-expanded={layerMenu} aria-controls="public-map-layers" onClick={() => setLayerMenu(!layerMenu)}><Layers3 size={19} /></button>
      {layerMenu && <fieldset id="public-map-layers" className="public-map-layers"><legend>공공자료 표시</legend>
        <label><input type="checkbox" checked={showCrossings} onChange={e => setShowCrossings(e.target.checked)} />횡단보도 시설 {crossings.points.length}곳</label>
        <label><input type="checkbox" checked={showDesignated} onChange={e => { if (!e.target.checked) fitRoute(); setShowDesignated(e.target.checked); }} />상습결빙 지정도로 {designated.records.length}곳</label>
      </fieldset>}
      <button type="button" title="경로 전체 보기" aria-label="경로 전체 보기" onClick={fitRoute}><Maximize2 size={19} /></button>
      <div className="zoom-buttons"><button type="button" aria-label="지도 확대" onClick={() => mapRef.current?.zoomIn()}><Plus size={21} /></button><button type="button" aria-label="지도 축소" onClick={() => mapRef.current?.zoomOut()}><Minus size={21} /></button></div>
      <button type="button" title="수집된 생활권 전체 보기" aria-label="수집된 생활권 전체 보기" onClick={fitNetwork}><LocateFixed size={20} /></button>
    </div>
    <div className="map-bottomline"><div className="map-legend"><span><i className="legend-recommended" />일반 보행 경로</span><span><i className="legend-network" />OSM 보행망</span></div><button type="button" className={`risk-toggle ${showCoverage ? 'on' : ''}`} aria-pressed={showCoverage} onClick={() => setShowCoverage(!showCoverage)}><Layers3 size={17} /><span>노면자료 미확보</span><i /></button></div>
    {(showDesignated || showCrossings || showCoverage) && <div className="surface-data-notice" role="status"><Info size={15} /><span>{showDesignated && <>주황 점은 지정도로의 시점·종점입니다. {designated.date} <a href={designated.url} target="_blank" rel="noreferrer">행안부</a>. </>}{showCrossings && <>청록 점은 횡단보도 시설 위치입니다. {crossings.date} <a href={crossings.url} target="_blank" rel="noreferrer">서울시</a>. </>}{showCoverage && '점선은 노면 관측자료가 없는 구간입니다.'}</span></div>}
    {tilesFailed && <div className="tile-warning" role="status">배경 지도를 불러오지 못했어요. 수집된 실제 OSM 보행망과 계산 경로는 계속 확인할 수 있습니다.</div>}
  </div>;
}
