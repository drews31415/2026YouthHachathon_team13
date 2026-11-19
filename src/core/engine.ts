import type { Coordinate, ModelRun, Network, Place, Route, RouteStep, SearchOptions, SearchResult, WalkSegment } from './types';
import { coordinateInside, distanceBetween, nearestNode } from './network';

/** No icing observations are available. Do not turn weather or absent data into fake risk estimates. */
export function analyzeRisk(network: Network): ModelRun {
  const checkedAt = new Date().toISOString();
  return {
    id: `no-icing-observations-${network.provenance.sha256}`, method: 'no-icing-observations',
    version: 'public-data-required-v1', analyzedAt: checkedAt, validUntil: null,
    temperatureC: null, precipitationMm: null,
    estimates: network.segments.map(segment => ({
      segmentId: segment.id, level: 'unknown', score: null, dataStatus: 'missing',
      reasons: ['이 구간의 공개 결빙·노면 상태 자료가 연결되지 않았습니다.', 'OSM 도로 자료와 지역 기상정보만으로 결빙 여부를 확인하지 않습니다.'],
    })),
  };
}

export function findPlaces(network: Network, query: string): Place[] {
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
  const normalized = normalize(String(query ?? ''));
  if (!normalized) return network.places.slice(0, 30);
  const matches = network.places.filter(place => {
    const text = normalize([place.name, place.category, ...(place.aliases ?? [])].join(' '));
    // Korean users commonly append 역 to a station's recorded name. This is a
    // search normalization only; it never alters the displayed source name.
    const stationMatch = place.category.includes('철도 · station') && normalized.endsWith('역')
      && normalize(place.name).includes(normalized.slice(0, -1));
    return text.includes(normalized) || stationMatch;
  });
  return matches.sort((a, b) => {
    const rank = (place: Place) => normalize(place.name) === normalized ? 0
      : place.category.includes('철도 · station') && normalize(place.name) === normalized.replace(/역$/, '') ? 1
        : normalize(place.name).startsWith(normalized) ? 2 : 3;
    const categoryRank = (place: Place) => place.entrance ? -1 : place.category.startsWith('기관 ·') || place.category.includes('철도 · station') ? 0
      : place.category === '교차로' || place.category.startsWith('대중교통 ·') || place.category.includes('철도 · stop') ? 2 : 1;
    return rank(a) - rank(b) || categoryRank(a) - categoryRank(b) || a.name.localeCompare(b.name, 'ko-KR');
  }).slice(0, 50);
}

/**
 * Real selected coordinate -> nearest existing OSM graph node, max 80m.
 * This does not assert the straight-line connection is publicly walkable.
 * The gap is returned separately and is NOT included in route geometry/time.
 */
export function nearestPlace(network: Network, coordinate: Coordinate): Place | null {
  const snap = nearestNode(network, coordinate);
  if (!snap) return null;
  return {
    id: `coordinate/${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`,
    name: '선택한 위치', category: '실제 좌표 · 도로 연결점 별도',
    coordinate: [...coordinate], nodeId: snap.node.id,
    routeCoordinate: [...snap.node.coordinate], snapDistanceM: snap.distanceM,
    sourceId: snap.node.id, sourceType: 'coordinate', sourceUrl: null,
  };
}

interface Traversal { segment: WalkSegment; reverse: boolean; from: string; to: string; }
interface QueueEntry { id: string; distance: number; }

class MinHeap {
  private items: QueueEntry[] = [];
  get size() { return this.items.length; }
  push(entry: QueueEntry) {
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].distance <= entry.distance) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = entry;
  }
  pop(): QueueEntry | undefined {
    const first = this.items[0]; const last = this.items.pop();
    if (this.items.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1; const right = left + 1;
        if (left >= this.items.length) break;
        const child = right < this.items.length && this.items[right].distance < this.items[left].distance ? right : left;
        if (this.items[child].distance >= last.distance) break;
        this.items[index] = this.items[child]; index = child;
      }
      this.items[index] = last;
    }
    return first;
  }
}

function allowedByAccessibility(segment: WalkSegment, options: SearchOptions): boolean {
  if (options.avoidStairs && segment.stairs !== false) return false;
  if (options.maxSlopePercent !== null && (segment.slope === null || Math.abs(segment.slope) > options.maxSlopePercent)) return false;
  return true;
}

/** The only graph connections are shared OSM node identifiers. */
function shortestPath(network: Network, originId: string, destinationId: string, options: SearchOptions,
  excluded?: ReadonlySet<string>, warningCosts?: ReadonlyMap<string, number>): Traversal[] | null {
  const adjacency = new Map(network.nodes.map(node => [node.id, [] as Traversal[]]));
  for (const segment of network.segments) {
    if (excluded?.has(segment.id) || !allowedByAccessibility(segment, options)) continue;
    if (segment.direction !== 'backward') adjacency.get(segment.from)?.push({ segment, from: segment.from, to: segment.to, reverse: false });
    if (segment.direction !== 'forward') adjacency.get(segment.to)?.push({ segment, from: segment.to, to: segment.from, reverse: true });
  }
  const distances = new Map<string, number>([[originId, 0]]);
  const previous = new Map<string, Traversal>();
  const queue = new MinHeap();
  queue.push({ id: originId, distance: 0 });
  while (queue.size) {
    const current = queue.pop()!;
    if (current.distance > (distances.get(current.id) ?? Infinity)) continue;
    if (current.id === destinationId) break;
    for (const traversal of adjacency.get(current.id) ?? []) {
      const candidate = current.distance + traversal.segment.lengthM + (warningCosts?.get(traversal.segment.id) ?? 0);
      if (candidate < (distances.get(traversal.to) ?? Infinity)) {
        distances.set(traversal.to, candidate); previous.set(traversal.to, traversal);
        queue.push({ id: traversal.to, distance: candidate });
      }
    }
  }
  if (!distances.has(destinationId)) return null;
  const path: Traversal[] = [];
  let cursor = destinationId;
  while (cursor !== originId) {
    const traversal = previous.get(cursor);
    if (!traversal) return null;
    path.push(traversal); cursor = traversal.from;
  }
  return path.reverse();
}

function bearing(from: Coordinate, to: Coordinate): number {
  const rad = Math.PI / 180; const dLon = (to[0] - from[0]) * rad;
  return Math.atan2(Math.sin(dLon) * Math.cos(to[1] * rad), Math.cos(from[1] * rad) * Math.sin(to[1] * rad) - Math.sin(from[1] * rad) * Math.cos(to[1] * rad) * Math.cos(dLon)) / rad;
}

function turnInstruction(previous: Coordinate[], current: Coordinate[], name: string): string {
  const entering = bearing(previous.at(-2)!, previous.at(-1)!); const leaving = bearing(current[0], current[1]);
  const turn = ((leaving - entering + 540) % 360) - 180;
  if (Math.abs(turn) < 30) return `${name} 구간을 따라 계속 이동`;
  if (Math.abs(turn) > 150) return `${name} 방향으로 돌아서 이동`;
  return `${turn > 0 ? '오른쪽' : '왼쪽'} ${name} 방향으로 이동`;
}

function buildRoute(path: Traversal[], speed: number, run: ModelRun): Route {
  const geometries = path.map(({ segment, reverse }) => reverse ? [...segment.coordinates].reverse() : [...segment.coordinates]);
  const coordinates = geometries.flatMap((geometry, index) => index === 0 ? geometry : geometry.slice(1));
  const distanceM = path.reduce((sum, entry) => sum + entry.segment.lengthM, 0);
  const steps: RouteStep[] = path.map(({ segment }, index) => ({
    segmentId: segment.id, name: segment.name, distanceM: segment.lengthM, durationSeconds: segment.lengthM / speed,
    instruction: index === 0 ? `${segment.name} 구간에서 출발` : turnInstruction(geometries[index - 1], geometries[index], segment.name),
    coordinate: geometries[index][0],
  }));
  return {
    id: `${run.id}-${path[0].from}-${path.at(-1)!.to}-${speed}`,
    type: 'normal', distanceM, durationSeconds: distanceM / speed, coordinates,
    segmentIds: path.map(entry => entry.segment.id), steps, highRiskCount: 0, unknownCount: path.length,
  };
}

function matchesGraph(network: Network, place: Place): boolean {
  const node = network.nodes.find(node => node.id === place.nodeId);
  return !!node && coordinateInside(place.coordinate, network.bounds)
    && Array.isArray(place.routeCoordinate) && distanceBetween(node.coordinate, place.routeCoordinate) < 0.01
    && Number.isFinite(place.snapDistanceM) && place.snapDistanceM >= 0 && place.snapDistanceM <= 80
    && Math.abs(distanceBetween(place.coordinate, node.coordinate) - place.snapDistanceM) < 0.01;
}

export function searchRoutes(network: Network, options: SearchOptions): SearchResult {
  const run = analyzeRisk(network);
  const fail = (status: SearchResult['status'], message: string, normal: Route | null = null): SearchResult => ({ status, message, run, normal, recommended: null, extraSeconds: null });
  if (!options || !options.origin || !options.destination
    || !Number.isFinite(options.walkingSpeedMps) || options.walkingSpeedMps < 0.3 || options.walkingSpeedMps > 2
    || typeof options.avoidStairs !== 'boolean'
    || (options.maxSlopePercent !== null && (!Number.isFinite(options.maxSlopePercent) || options.maxSlopePercent < 0 || options.maxSlopePercent > 100))) return fail('invalid-input', '출발지·목적지와 보행 설정을 확인해 주세요.');
  if (!matchesGraph(network, options.origin) || !matchesGraph(network, options.destination)) return fail('out-of-area', '선택 위치를 수집된 보행망에 연결할 수 없습니다. 지도 범위 안에서 실제 도로와 80m 이내인 위치를 선택해 주세요.');
  if (options.origin.nodeId === options.destination.nodeId) return fail('invalid-input', '출발지와 목적지가 같은 도로 연결점입니다. 서로 다른 위치를 선택해 주세요.');
  const path = shortestPath(network, options.origin.nodeId, options.destination.nodeId, options);
  if (!path?.length) return fail('no-route', options.avoidStairs || options.maxSlopePercent !== null
    ? '선택한 계단·경사 조건을 확인할 수 있는 연결 경로가 없습니다. 정보가 없는 구간도 제외됩니다.'
    : '수집된 OSM 자료에서 두 연결점을 잇는 보행 경로를 찾지 못했습니다. 횡단시설·접근권한·자료 누락을 확인해야 합니다.');
  const normal = buildRoute(path, options.walkingSpeedMps, run);
  return fail('no-recommendation', '실제 OSM 도로망의 일반 경로입니다. 출발·도착 위치에서 도로 연결점까지의 접근 구간은 제외합니다.', normal);
}

export interface ForecastDetour {
  crossings: number;
  route: Route | null;
  partial?: boolean;
  heatingComparison?: { normal: number; alternate: number | null };
}

/** A joint in the OSM graph is required on both sides of a flagged section. */
export function findForecastDetour(network: Network, options: SearchOptions, result: SearchResult,
  excluded: ReadonlySet<string>, heatedWarningSegments?: ReadonlySet<string>): ForecastDetour {
  const { normal, run } = result;
  const { origin, destination } = options;
  if (!normal || !origin || !destination) return { crossings: 0, route: null };
  const crossings = normal.segmentIds.filter(id => excluded.has(id)).length;
  if (!crossings) return { crossings, route: null };
  const detour: ForecastDetour = { crossings, route: null };
  let path = shortestPath(network, origin.nodeId, destination.nodeId, options, excluded);
  if (heatedWarningSegments?.size) {
    // The 20% reduction is a pilot routing weight, never a measured change in icing probability.
    const costs = new Map(network.segments.filter(segment => excluded.has(segment.id)).map(segment =>
      [segment.id, segment.lengthM * (heatedWarningSegments.has(segment.id) ? 0.8 : 1)]));
    const warningScore = (ids: readonly string[]) => ids.reduce((sum, id) => sum + (costs.get(id) ?? 0), 0);
    const usesHeating = (ids: readonly string[]) => ids.some(id => heatedWarningSegments.has(id) && excluded.has(id));
    const normalScore = warningScore(normal.segmentIds);
    if (!path?.length) {
      const candidate = shortestPath(network, origin.nodeId, destination.nodeId, options, undefined, costs);
      const candidateIds = candidate?.map(entry => entry.segment.id) ?? [];
      if (candidate?.length && warningScore(candidateIds) < normalScore && (usesHeating(normal.segmentIds) || usesHeating(candidateIds))) {
        path = candidate;
        detour.partial = true;
      }
    }
    const alternateIds = path?.map(entry => entry.segment.id);
    if (usesHeating(normal.segmentIds) || (alternateIds && usesHeating(alternateIds))) {
      detour.heatingComparison = { normal: normalScore, alternate: alternateIds ? warningScore(alternateIds) : null };
    }
  }
  if (path?.length) {
    const route = buildRoute(path, options.walkingSpeedMps, run);
    detour.route = { ...route, type: 'recommended', id: normal.id + '-detour-' + route.segmentIds.join(',') };
  }
  return detour;
}
