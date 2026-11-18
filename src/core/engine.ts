import type {
  Coordinate, ModelRun, Place, RiskEstimate, Route, RouteStep,
  Scenario, SearchOptions, SearchResult, WalkSegment,
} from './types';
import { distanceBetween, network } from './network';

export { network } from './network';

const SCENARIOS: Scenario[] = ['freezing', 'dry', 'missing', 'stale', 'blocked'];
const VALIDITY_MS = 30 * 60 * 1000;

export interface RiskFeatures {
  temperatureC: number | null;
  precipitationMm: number | null;
  moisture: number | null;
  shade: number | null;
}

/**
 * Inputs are a synthetic temperature, preceding 24h rain/snow-water amount,
 * residual-moisture proxy [0,1] and shade proxy [0,1]. The moisture proxy is
 * independent: zero recent precipitation does not prove a dry surface.
 * Weights and the 3mm normalization constant have NOT been field calibrated.
 */
export function scoreRiskFeatures(features: RiskFeatures): number | null {
  const { temperatureC, precipitationMm, moisture, shade } = features;
  if (Object.values(features).some(value => value === null || !Number.isFinite(value))
    || temperatureC === null || precipitationMm === null || moisture === null || shade === null
    || precipitationMm < 0 || moisture < 0 || moisture > 1 || shade < 0 || shade > 1) return null;
  const recentPrecipitation = Math.min(1, precipitationMm / 3);
  return temperatureC <= 0
    ? Math.min(1, 0.35 + moisture * 0.45 + recentPrecipitation * 0.15 + shade * 0.1)
    : 0.04 + moisture * 0.1 + recentPrecipitation * 0.03 + shade * 0.04;
}

/**
 * Transparent rule baseline for demonstration, not a trained model.
 * A risk score is an ordinal heuristic, NOT an icing probability.
 * Slope is intentionally absent from the risk rule: it affects walkability,
 * but is not evidence that ice formed. All weather/environment inputs are fake.
 */
export function analyzeRisk(scenario: Scenario): ModelRun {
  const safeScenario = SCENARIOS.includes(scenario) ? scenario : 'missing';
  const now = Date.now();
  const analyzedAt = new Date(safeScenario === 'stale' ? now - 2 * 60 * 60 * 1000 : now).toISOString();
  const temperatureC = safeScenario === 'missing' ? null : safeScenario === 'dry' ? 6 : -3;
  const precipitationMm = safeScenario === 'missing' ? null : safeScenario === 'dry' ? 0 : 1.8;
  const estimates: RiskEstimate[] = network.segments.map(segment => {
    if (safeScenario === 'stale') return {
      segmentId: segment.id, level: 'unknown', score: null, dataStatus: 'stale',
      reasons: ['자료 유효시간이 지났습니다. 새로운 자료가 필요합니다.'],
    };
    if (safeScenario === 'missing' || temperatureC === null || precipitationMm === null
      || segment.shade === null || segment.moisture === null) return {
      segmentId: segment.id, level: 'unknown', score: null, dataStatus: 'missing',
      reasons: ['기상 또는 보행환경 자료가 부족해 위험을 판단할 수 없습니다.'],
    };
    if (safeScenario === 'blocked') return {
      segmentId: segment.id, level: 'high', score: 1, dataStatus: 'complete',
      reasons: ['추천 불가 상황을 확인하기 위한 전 구간 고위험 시뮬레이션입니다.'],
    };
    const score = scoreRiskFeatures({ temperatureC, precipitationMm, moisture: segment.moisture, shade: segment.shade })!;
    const level = score >= 0.7 ? 'high' : score >= 0.35 ? 'medium' : 'low';
    const reasons = temperatureC <= 0
      ? [
        '영하 기온을 가정한 시연입니다.',
        '이전 24시간 강수·눈의 물 환산량 1.8mm를 가정했습니다.',
        segment.moisture >= 0.6 ? '잔여 수분이 많은 구간을 가정했습니다.' : '잔여 수분이 적은 구간을 가정했습니다.',
        segment.shade >= 0.6 ? '그늘이 많은 구간을 가정했습니다.' : '그늘이 적은 구간을 가정했습니다.',
      ]
      : ['영상 6°C, 최근 강수 없음의 건조한 날씨를 가정한 시연입니다.'];
    return { segmentId: segment.id, level, score, reasons, dataStatus: 'complete' };
  });
  return {
    id: `demo-${safeScenario}-${now}`, method: 'rule-based-simulation', version: 'demo-rule-v1',
    analyzedAt, validUntil: new Date(Date.parse(analyzedAt) + VALIDITY_MS).toISOString(),
    scenario: safeScenario, temperatureC, precipitationMm, estimates,
  };
}

/** Only these explicit demo places are searchable. There is no hidden geocoder. */
export function findPlaces(query: string): Place[] {
  const normalized = String(query ?? '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');
  if (!normalized) return [...network.places];
  return network.places.filter(place =>
    `${place.name}${place.category}`.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko').includes(normalized));
}

/** Location is held in memory by the caller. Refuse out-of-area/large snaps. */
export function nearestPlace(coordinate: Coordinate): Place | null {
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || coordinate.some(value => !Number.isFinite(value))) return null;
  const [[west, south], [east, north]] = network.bounds;
  if (coordinate[0] < west || coordinate[0] > east || coordinate[1] < south || coordinate[1] > north) return null;
  const nearest = network.places.reduce<Place | null>((best, place) =>
    !best || distanceBetween(coordinate, place.coordinate) < distanceBetween(coordinate, best.coordinate) ? place : best, null);
  return nearest && distanceBetween(coordinate, nearest.coordinate) <= 250 ? nearest : null;
}

interface Traversal { segment: WalkSegment; reverse: boolean; from: string; to: string; }

function allowedByAccessibility(segment: WalkSegment, options: SearchOptions): boolean {
  // Unknown accessibility metadata cannot satisfy an explicit constraint.
  if (options.avoidStairs && segment.stairs !== false) return false;
  if (options.maxSlopePercent !== null && (segment.slope === null || Math.abs(segment.slope) > options.maxSlopePercent)) return false;
  return true;
}

/** Dijkstra over the actual fixture adjacency; returned geometry follows it. */
function shortestPath(originNode: string, destinationNode: string, allowed: WalkSegment[]): Traversal[] | null {
  const adjacency = new Map(network.nodes.map(node => [node.id, [] as Traversal[]]));
  for (const segment of allowed) {
    adjacency.get(segment.from)?.push({ segment, from: segment.from, to: segment.to, reverse: false });
    adjacency.get(segment.to)?.push({ segment, from: segment.to, to: segment.from, reverse: true });
  }
  const distances = new Map<string, number>([[originNode, 0]]);
  const previous = new Map<string, Traversal>();
  const pending = new Set(network.nodes.map(node => node.id));
  while (pending.size) {
    let current: string | null = null;
    let smallest = Infinity;
    for (const node of pending) {
      const distance = distances.get(node) ?? Infinity;
      if (distance < smallest) { current = node; smallest = distance; }
    }
    if (current === null) break;
    pending.delete(current);
    if (current === destinationNode) break;
    for (const traversal of adjacency.get(current) ?? []) {
      if (!pending.has(traversal.to)) continue;
      const candidate = smallest + traversal.segment.lengthM;
      if (candidate < (distances.get(traversal.to) ?? Infinity)) {
        distances.set(traversal.to, candidate);
        previous.set(traversal.to, traversal);
      }
    }
  }
  if (!distances.has(destinationNode)) return null;
  const path: Traversal[] = [];
  let cursor = destinationNode;
  while (cursor !== originNode) {
    const traversal = previous.get(cursor);
    if (!traversal) return null;
    path.unshift(traversal);
    cursor = traversal.from;
  }
  return path;
}

function bearing(from: Coordinate, to: Coordinate): number {
  const rad = Math.PI / 180;
  const dLon = (to[0] - from[0]) * rad;
  return Math.atan2(
    Math.sin(dLon) * Math.cos(to[1] * rad),
    Math.cos(from[1] * rad) * Math.sin(to[1] * rad)
      - Math.sin(from[1] * rad) * Math.cos(to[1] * rad) * Math.cos(dLon),
  ) / rad;
}

function turnInstruction(previous: Coordinate[], current: Coordinate[], name: string): string {
  const entering = bearing(previous[previous.length - 2], previous[previous.length - 1]);
  const leaving = bearing(current[0], current[1]);
  const turn = ((leaving - entering + 540) % 360) - 180;
  if (Math.abs(turn) < 30) return `${name} 방향으로 계속 걸어가세요`;
  if (Math.abs(turn) > 150) return `${name} 방향으로 돌아가세요`;
  return `${turn > 0 ? '오른쪽' : '왼쪽'}으로 돌아 ${name} 방향으로 가세요`;
}

function buildRoute(path: Traversal[], type: Route['type'], speed: number, run: ModelRun): Route {
  const estimates = new Map(run.estimates.map(risk => [risk.segmentId, risk]));
  const geometries = path.map(({ segment, reverse }) => reverse
    ? [...segment.coordinates].reverse() : [...segment.coordinates]);
  const coordinates = geometries.flatMap((geometry, index) => index === 0 ? geometry : geometry.slice(1));
  const distanceM = path.reduce((sum, entry) => sum + entry.segment.lengthM, 0);
  // Keep full precision internally. Round only for display, after subtraction.
  const steps: RouteStep[] = path.map(({ segment }, index) => ({
    segmentId: segment.id, name: segment.name, distanceM: segment.lengthM,
    durationSeconds: segment.lengthM / speed,
    instruction: index === 0 ? `${segment.name} 방향으로 출발하세요` : turnInstruction(geometries[index - 1], geometries[index], segment.name),
    coordinate: geometries[index][0],
  }));
  return {
    id: `${run.id}-${type}`, type, coordinates, distanceM,
    durationSeconds: distanceM / speed, steps,
    segmentIds: path.map(entry => entry.segment.id),
    highRiskCount: path.filter(entry => estimates.get(entry.segment.id)?.level === 'high').length,
    unknownCount: path.filter(entry => estimates.get(entry.segment.id)?.level === 'unknown').length,
  };
}

export function searchRoutes(options: SearchOptions): SearchResult {
  const run = analyzeRisk(options?.scenario);
  const fail = (status: SearchResult['status'], message: string, normal: Route | null = null): SearchResult => ({
    status, message, run, normal, recommended: null, extraSeconds: null,
  });
  if (!options || !SCENARIOS.includes(options.scenario)
    || typeof options.originId !== 'string' || typeof options.destinationId !== 'string'
    || !options.originId.trim() || !options.destinationId.trim()
    || !Number.isFinite(options.walkingSpeedMps) || options.walkingSpeedMps < 0.3 || options.walkingSpeedMps > 2
    || typeof options.avoidStairs !== 'boolean'
    || (options.maxSlopePercent !== null && (!Number.isFinite(options.maxSlopePercent) || options.maxSlopePercent < 0 || options.maxSlopePercent > 100))) {
    return fail('invalid-input', '출발지·목적지와 보행 설정을 확인해 주세요. 보행속도는 초당 0.3~2m 범위입니다.');
  }
  const origin = network.places.find(place => place.id === options.originId);
  const destination = network.places.find(place => place.id === options.destinationId);
  if (!origin || !destination) return fail('out-of-area', '현재는 관악구 시연 생활권의 등록된 장소만 조회할 수 있어요. 목록에서 장소를 선택해 주세요.');
  if (origin.nodeId === destination.nodeId) return fail('invalid-input', '출발지와 목적지가 같아요. 서로 다른 장소를 선택해 주세요.');
  if (options.scenario === 'missing') return fail('insufficient-data', '기상·보행환경 자료가 부족해 위험을 판단할 수 없어요. 자료 부족을 낮은 위험으로 표시하지 않습니다.');
  if (options.scenario === 'stale' || Date.now() >= Date.parse(run.validUntil)) return fail('stale-data', '자료 유효시간이 지났어요. 정보를 갱신한 뒤 다시 조회해 주세요.');

  const accessible = network.segments.filter(segment => allowedByAccessibility(segment, options));
  const normalPath = shortestPath(origin.nodeId, destination.nodeId, accessible);
  if (!normalPath) return fail('no-route', '선택한 계단·경사 조건을 충족하는 보행 경로를 찾지 못했어요. 장소 또는 보행 설정을 바꿔 주세요.');
  const normal = buildRoute(normalPath, 'normal', options.walkingSpeedMps, run);
  const estimates = new Map(run.estimates.map(estimate => [estimate.segmentId, estimate]));
  const recommendedPath = shortestPath(origin.nodeId, destination.nodeId, accessible.filter(segment => {
    const risk = estimates.get(segment.id);
    return risk?.dataStatus === 'complete' && (risk.level === 'low' || risk.level === 'medium');
  }));
  if (!recommendedPath) return fail('no-recommendation', '위험이 높거나 정보가 부족한 구간을 제외하면 추천할 수 있는 경로가 없어요. 일반 경로는 결빙 위험을 피하는 경로가 아닙니다.', normal);
  const recommended = buildRoute(recommendedPath, 'recommended', options.walkingSpeedMps, run);
  return {
    status: 'ok', run, normal, recommended,
    extraSeconds: recommended.durationSeconds - normal.durationSeconds,
    message: recommended.segmentIds.join('|') === normal.segmentIds.join('|')
      ? '일반 경로와 추천 경로가 같아요. 현장 노면 상태는 직접 확인해 주세요.'
      : '위험이 높거나 자료가 부족한 구간을 제외한 시연 경로입니다. 실제 통행 안전을 보장하지 않습니다.',
  };
}
