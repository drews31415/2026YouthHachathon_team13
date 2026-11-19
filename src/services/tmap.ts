import type { Coordinate, Place, Route, SearchOptions } from '../core/types';

async function readJson<T>(path: string, init: RequestInit, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('보행 길찾기 서비스에 연결할 수 없어요.');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '보행 길찾기 서비스에 연결할 수 없어요.');
  return data;
}

export function coordinatePlace(coordinate: Coordinate, name: string): Place {
  return {
    id: `coordinate/${coordinate.join(',')}`, name, category: '선택한 위치', coordinate, routeCoordinate: coordinate,
    nodeId: '', snapDistanceM: 0, sourceId: '', sourceType: 'coordinate', sourceUrl: null,
  };
}

export async function fetchTmapPlaces(query: string, signal: AbortSignal): Promise<Place[]> {
  type Poi = { id: string; name: string; address: string; lon: number; lat: number };
  const data = await readJson<{ places: Poi[] }>('/api/tmap/places?' + new URLSearchParams({ q: query }), {}, signal);
  return data.places.map(({ id, name, address, lon, lat }) => ({
    ...coordinatePlace([lon, lat], name), id: 'tmap/' + id, sourceId: id, address,
  }));
}

export async function fetchTmapWalkingRoute(origin: Place, destination: Place, options: SearchOptions, signal: AbortSignal): Promise<Route> {
  type Step = { index: number; name: string; instruction: string; coordinate: Coordinate; distanceMeters: number | null };
  const endpoint = (place: Place) => ({ lon: place.coordinate[0], lat: place.coordinate[1], name: place.name });
  const data = await readJson<{ lines: Coordinate[][]; distanceMeters: number; steps: Step[] }>('/api/tmap/route', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: endpoint(origin), end: endpoint(destination), avoidStairs: options.avoidStairs }),
  }, signal);
  return {
    id: `tmap/${origin.id}/${destination.id}`, type: 'normal', provider: 'tmap', lines: data.lines,
    coordinates: data.lines.flat(), distanceM: data.distanceMeters, durationSeconds: data.distanceMeters / options.walkingSpeedMps,
    segmentIds: [], highRiskCount: 0, unknownCount: 0,
    steps: data.steps.map(step => ({
      segmentId: String(step.index), name: step.name, instruction: step.instruction, coordinate: step.coordinate,
      distanceM: step.distanceMeters ?? 0, durationSeconds: (step.distanceMeters ?? 0) / options.walkingSpeedMps,
    })),
  };
}
