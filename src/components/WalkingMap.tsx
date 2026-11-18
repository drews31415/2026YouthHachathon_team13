import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import { Layers3, LocateFixed, Minus, Plus, Snowflake, MapPin, Maximize2 } from 'lucide-react';
import type { ModelRun, Network, Place, Route, RouteStep } from '../core/types';

interface Props {
  network: Network; run: ModelRun; normal: Route | null; recommended: Route | null;
  selected: 'normal' | 'recommended'; origin?: Place; destination?: Place;
  step?: RouteStep; recenterKey: number;
}
const latlngs = (coordinates: [number, number][]) => coordinates.map(([lng, lat]) => [lat, lng] as L.LatLngTuple);
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const riskNames = { high: '결빙 위험 높음 · 시뮬레이션', medium: '결빙 위험 주의 · 시뮬레이션', low: '상대적 위험 낮음 · 시뮬레이션', unknown: '위험 판단 정보 부족' };

export function WalkingMap({ network, run, normal, recommended, selected, origin, destination, step, recenterKey }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const [showRisk, setShowRisk] = useState(true);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [resizeVersion, setResizeVersion] = useState(0);

  useEffect(() => {
    if (!host.current) return;
    const map = L.map(host.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: true, minZoom: 13, maxZoom: 19 });
    mapRef.current = map;
    const tile = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    tile.on('tileerror', () => setTilesFailed(true));
    tile.on('tileload', () => setTilesFailed(false));
    layers.current = L.layerGroup().addTo(map);
    const [[west, south], [east, north]] = network.bounds;
    map.fitBounds([[south, west], [north, east]], { padding: [56, 100] });
    const resize = new ResizeObserver(() => { map.invalidateSize(); setResizeVersion(version => version + 1); });
    resize.observe(host.current);
    return () => { resize.disconnect(); map.remove(); mapRef.current = null; layers.current = null; };
  }, [network]);

  useEffect(() => {
    const group = layers.current;
    if (!group) return;
    group.clearLayers();
    const riskById = new Map(run.estimates.map(item => [item.segmentId, item]));
    network.segments.forEach(segment => {
      const risk = riskById.get(segment.id);
      const points = latlngs(segment.coordinates);
      L.polyline(points, { color: '#ffffff', weight: 7, opacity: .92, interactive: false }).addTo(group);
      L.polyline(points, { color: '#aabcb8', weight: 2, opacity: .5, interactive: false }).addTo(group);
      if (showRisk && risk && risk.level !== 'low') {
        const color = risk.level === 'high' ? '#159bb9' : risk.level === 'medium' ? '#d38b29' : '#7c8495';
        const line = L.polyline(points, { color, weight: 7, opacity: .7, dashArray: risk.level === 'unknown' ? '3 8' : '1 10', lineCap: 'round' }).addTo(group);
        line.bindPopup(`<div class="risk-popup"><span>${escape(riskNames[risk.level])}</span><strong>${escape(segment.name)}</strong><ul>${risk.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul><small>실제 노면을 확인한 결과가 아닙니다.</small></div>`);
      }
    });
    const routeLine = (route: Route, active: boolean) => {
      const coords = latlngs(route.coordinates);
      if (active) L.polyline(coords, { color: '#fff', weight: 12, opacity: .98, interactive: false }).addTo(group);
      L.polyline(coords, {
        color: route.type === 'recommended' ? '#1765ef' : active ? '#53677e' : '#84929b',
        weight: active ? 7 : 4, opacity: active ? 1 : .75, dashArray: route.type === 'normal' ? '7 9' : undefined,
        lineJoin: 'round', interactive: false,
      }).addTo(group);
    };
    const inactive = selected === 'recommended' ? normal : recommended;
    const active = selected === 'recommended' ? recommended : normal;
    if (inactive) routeLine(inactive, false);
    if (active) routeLine(active, true);

    if (showRisk) {
      network.segments.filter(segment => riskById.get(segment.id)?.level === 'high').forEach(segment => {
        const risk = riskById.get(segment.id)!;
        const first = segment.coordinates[0];
        const last = segment.coordinates[segment.coordinates.length - 1];
        const center = [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
        const icon = L.divIcon({ className: 'risk-marker', html: '<span aria-hidden="true">❄</span>', iconSize: [34, 34], iconAnchor: [17, 17] });
        L.marker([center[1], center[0]], { icon, title: `${segment.name}: 결빙 위험 높음 (시뮬레이션)` }).addTo(group)
          .bindPopup(`<div class="risk-popup"><span>${escape(riskNames.high)}</span><strong>${escape(segment.name)}</strong><ul>${risk.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul><small>실제 노면을 확인한 결과가 아닙니다.</small></div>`);
      });
    }
    network.places.filter(place => place.id !== origin?.id && place.id !== destination?.id).forEach(place => {
      L.circleMarker([place.coordinate[1], place.coordinate[0]], { radius: 4, color: '#fff', weight: 2, fillColor: '#6b8199', fillOpacity: .8 }).addTo(group)
        .bindTooltip(escape(place.name), { direction: 'top', className: 'quiet-place-label', permanent: true, offset: [0, -5] });
    });
    if (origin) {
      const icon = L.divIcon({ className: 'endpoint-marker origin-marker', html: '<span>출발</span>', iconSize: [40, 40], iconAnchor: [20, 20] });
      L.marker([origin.coordinate[1], origin.coordinate[0]], { icon, title: `출발: ${origin.name}` }).addTo(group)
        .bindTooltip(escape(origin.name), { direction: 'right', permanent: true, offset: [22, 0], className: 'endpoint-label' });
    }
    if (destination) {
      const icon = L.divIcon({ className: 'endpoint-marker destination-marker', html: '<span>도착</span>', iconSize: [40, 40], iconAnchor: [20, 20] });
      L.marker([destination.coordinate[1], destination.coordinate[0]], { icon, title: `도착: ${destination.name}` }).addTo(group)
        .bindTooltip(escape(destination.name), { direction: 'right', permanent: true, offset: [22, 0], className: 'endpoint-label' });
    }
    if (step) {
      const icon = L.divIcon({ className: 'navigation-marker', html: '<span>▲</span>', iconSize: [42, 42], iconAnchor: [21, 21] });
      L.marker([step.coordinate[1], step.coordinate[0]], { icon, title: '경로 따라보기 위치 (시연)' }).addTo(group);
    }
  }, [network, run, normal, recommended, selected, origin, destination, showRisk, step]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const route = selected === 'recommended' ? recommended : normal;
    if (route?.coordinates.length) map.fitBounds(L.latLngBounds(latlngs(route.coordinates)), { paddingTopLeft: [72, 100], paddingBottomRight: [110, 100], maxZoom: 17, animate: true });
    else { const [[west, south], [east, north]] = network.bounds; map.fitBounds([[south, west], [north, east]], { padding: [56, 100], animate: true }); }
  }, [normal, recommended, selected, recenterKey, network, resizeVersion]);

  return <div className="map-wrapper">
    <div className="walking-map" ref={host} role="region" aria-label="관악구 보행 경로 지도. 결빙 위험과 경로는 시뮬레이션입니다." />
    <div className="map-topline"><span className="area-chip"><span className="live-dot" /><MapPin size={14} /> 서울 관악구 <span className="area-chip-sub">시범 생활권</span></span><span className="map-demo-tag">시뮬레이션 지도</span></div>
    <div className="map-tools">
      <button type="button" title="경로 전체 보기" aria-label="경로 전체 보기" onClick={() => { const route = selected === 'recommended' ? recommended : normal; if (route) mapRef.current?.fitBounds(L.latLngBounds(latlngs(route.coordinates)), { padding: [70, 90], maxZoom: 17 }); }}><Maximize2 size={19} /></button>
      <div className="zoom-buttons"><button type="button" aria-label="지도 확대" onClick={() => mapRef.current?.zoomIn()}><Plus size={21} /></button><button type="button" aria-label="지도 축소" onClick={() => mapRef.current?.zoomOut()}><Minus size={21} /></button></div>
      <button type="button" title="생활권 중심으로" aria-label="생활권 중심으로" onClick={() => { const [[west, south], [east, north]] = network.bounds; mapRef.current?.fitBounds([[south, west], [north, east]], { padding: [56, 100] }); }}><LocateFixed size={20} /></button>
    </div>
    <div className="map-bottomline">
      <div className="map-legend"><span><i className="legend-recommended" />추천 경로</span><span><i className="legend-normal" />일반 경로</span><span><Snowflake size={14} className="icy" />위험 예상</span></div>
      <button type="button" className={`risk-toggle ${showRisk ? 'on' : ''}`} aria-label="위험 구간 표시" aria-pressed={showRisk} onClick={() => setShowRisk(!showRisk)}><Layers3 size={17} /><span>위험 구간</span><i /></button>
    </div>
    {tilesFailed && <div className="tile-warning" role="status">배경 지도를 불러오지 못했어요. 시연 경로와 위험 구간은 계속 확인할 수 있습니다.</div>}
  </div>;
}
