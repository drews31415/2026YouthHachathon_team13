import type { Coordinate, Network, OsmElement, OsmEntranceDataset, OsmPayload, Place, SourceProvenance, WalkNode, WalkSegment } from './types';
import { buildingsWithHeight } from './icing-forecast';

// Tag semantics checked against the public OSM documentation:
// https://wiki.openstreetmap.org/wiki/Key:access
// https://wiki.openstreetmap.org/wiki/Key:oneway:foot
// https://wiki.openstreetmap.org/wiki/Key:incline
// The conservative exclusions below are routing policy, not additional observations.

const EARTH_RADIUS_M = 6_371_008.8;
export const MAX_SNAP_DISTANCE_M = 80;
const ALLOWED_FOOT = new Set(['yes', 'designated', 'permissive', 'official', 'public']);
const RESTRICTED_ACCESS = new Set(['no', 'private', 'customers', 'delivery', 'destination', 'permit', 'agricultural', 'forestry', 'use_sidepath']);
const PUBLIC_ROAD_CLASSES = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'road', 'track']);
const radians = (degrees: number) => degrees * Math.PI / 180;

/** Geodesic calculation only: no elevation, shade or moisture is fabricated. */
export function distanceBetween(a: Coordinate, b: Coordinate): number {
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function geometryLength(coordinates: Coordinate[]): number {
  return coordinates.slice(1).reduce((sum, coordinate, index) => sum + distanceBetween(coordinates[index], coordinate), 0);
}

export function coordinateInside(coordinate: Coordinate, bounds: Network['bounds']): boolean {
  if (!Array.isArray(coordinate) || coordinate.length !== 2 || !coordinate.every(Number.isFinite)) return false;
  const [[west, south], [east, north]] = bounds;
  return coordinate[0] >= west && coordinate[0] <= east && coordinate[1] >= south && coordinate[1] <= north;
}

/** Explicit foot permissions override general access; unresolved conditional rules are excluded. */
export function isFootAccessible(tags: Record<string, string>): boolean {
  const highway = tags.highway;
  if (!highway || tags.area === 'yes' || ['construction', 'proposed', 'motorway', 'motorway_link'].includes(highway)) return false;
  if (tags['foot:conditional'] || tags['access:conditional']) return false;
  const foot = tags.foot?.toLowerCase();
  const access = tags.access?.toLowerCase();
  if (foot && RESTRICTED_ACCESS.has(foot)) return false;
  if (foot && ALLOWED_FOOT.has(foot)) return true;
  if (access && RESTRICTED_ACCESS.has(access)) return false;
  if (access && !ALLOWED_FOOT.has(access)) return false;
  // A bicycle-only route needs an explicit pedestrian permission.
  if (highway === 'cycleway' || highway === 'trunk' || highway === 'trunk_link' || highway === 'bridleway') return false;
  if (foot && !ALLOWED_FOOT.has(foot)) return false;
  return PUBLIC_ROAD_CLASSES.has(highway);
}

/** An unconfirmed barrier is not silently assumed passable. */
export function isNodePassable(tags: Record<string, string>): boolean {
  if (tags['foot:conditional'] || tags['access:conditional']) return false;
  const foot = tags.foot?.toLowerCase();
  if (foot && RESTRICTED_ACCESS.has(foot)) return false;
  if (foot && ALLOWED_FOOT.has(foot)) return true;
  if (tags.access && RESTRICTED_ACCESS.has(tags.access.toLowerCase())) return false;
  if (tags.access && !ALLOWED_FOOT.has(tags.access.toLowerCase())) return false;
  if (tags.barrier && !['no', 'entrance'].includes(tags.barrier)) return false;
  return true;
}

function inclinePercent(tags: Record<string, string>): number | null {
  const raw = tags.incline?.trim();
  if (!raw || !/^[+-]?\d+(?:\.\d+)?\s*(?:%|°)?$/.test(raw)) return null;
  const value = Number.parseFloat(raw);
  const percent = raw.endsWith('°') ? Math.tan(radians(value)) * 100 : value;
  return Number.isFinite(percent) && Math.abs(percent) <= 1000 ? percent : null;
}

function stairsStatus(tags: Record<string, string>): boolean | null {
  if (tags.highway === 'steps' || tags.stairs === 'yes') return true;
  if (tags.step_count && /^\d+$/.test(tags.step_count)) return Number(tags.step_count) > 0;
  if (tags.stairs === 'no' || tags.steps === 'no') return false;
  // A non-steps highway tag alone is not a verified no-stairs survey.
  return null;
}

function footDirection(tags: Record<string, string>): WalkSegment['direction'] | null {
  const value = tags['oneway:foot']?.trim().toLowerCase();
  if (!value && !tags['foot:forward'] && !tags['foot:backward']
    && ['footway', 'path', 'steps', 'pedestrian'].includes(tags.highway)
    && tags.oneway && !['no', 'false', '0'].includes(tags.oneway)) return null;
  let direction: WalkSegment['direction'];
  if (!value || ['no', 'false', '0'].includes(value)) direction = 'both';
  else if (['yes', 'true', '1'].includes(value)) direction = 'forward';
  else if (value === '-1' || value === 'reverse') direction = 'backward';
  else return null; // Unknown direction must not become a bidirectional edge.
  const forward = tags['foot:forward']?.trim().toLowerCase();
  const backward = tags['foot:backward']?.trim().toLowerCase();
  const forwardAllowed = direction !== 'backward' && (!forward || ALLOWED_FOOT.has(forward));
  const backwardAllowed = direction !== 'forward' && (!backward || ALLOWED_FOOT.has(backward));
  return forwardAllowed && backwardAllowed ? 'both' : forwardAllowed ? 'forward' : backwardAllowed ? 'backward' : null;
}

function normalizedTags(tags?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(tags ?? {}).filter(([, value]) => typeof value === 'string'));
}

export function nearestNode(network: Pick<Network, 'nodes' | 'bounds'>, coordinate: Coordinate): { node: WalkNode; distanceM: number } | null {
  if (!coordinateInside(coordinate, network.bounds)) return null;
  let selected: WalkNode | null = null;
  let minimum = Infinity;
  for (const node of network.nodes) {
    const gap = distanceBetween(coordinate, node.coordinate);
    if (gap < minimum) { minimum = gap; selected = node; }
  }
  return selected && minimum <= MAX_SNAP_DISTANCE_M ? { node: selected, distanceM: minimum } : null;
}

function categoryFor(tags: Record<string, string>, type: 'node' | 'way'): string {
  const category = tags.amenity ? `시설 · ${tags.amenity}`
    : tags.office ? `기관 · ${tags.office}`
      : tags.shop ? `상점 · ${tags.shop}`
      : tags.railway ? `철도 · ${tags.railway}`
        : tags.public_transport ? `대중교통 · ${tags.public_transport}`
          : tags.leisure ? `여가 · ${tags.leisure}`
            : tags.tourism ? `관광 · ${tags.tourism}`
              : tags.junction ? '교차로'
                : tags.highway ? `도로시설 · ${tags.highway}`
                  : tags.building ? `건물 · ${tags.building}` : 'OSM 이름 등록 지점';
  return type === 'way' ? `${category} · 도형 중심` : category;
}

function checkedProvenance(provenance: SourceProvenance, payload: OsmPayload): SourceProvenance {
  if (!provenance || !provenance.source || !provenance.endpoint || !provenance.license || !provenance.licenseUrl
    || !/^[a-f0-9]{64}$/i.test(provenance.sha256 ?? '')
    || !Number.isFinite(Date.parse(provenance.downloadedAt)) || !Number.isFinite(Date.parse(provenance.osmTimestamp))
    || !Array.isArray(provenance.bbox) || provenance.bbox.length !== 4 || !provenance.bbox.every(Number.isFinite)) {
    throw new Error('OSM 출처·기준 시각·파일 해시가 누락되어 보행망을 사용할 수 없습니다.');
  }
  const [south, west, north, east] = provenance.bbox;
  if (!(south < north && west < east && south >= -90 && north <= 90 && west >= -180 && east <= 180)) throw new Error('OSM 수집 범위가 올바르지 않습니다.');
  if (payload.osm3s?.timestamp_osm_base && Date.parse(payload.osm3s.timestamp_osm_base) !== Date.parse(provenance.osmTimestamp)) throw new Error('OSM 원본과 출처 문서의 기준 시각이 다릅니다.');
  return { ...provenance, bbox: [...provenance.bbox] };
}

/**
 * Build only edges that occur consecutively in a real OSM way. Geometric
 * crossings do not connect unless both ways reference the SAME OSM node ID.
 * Unknown access constraints, barriers and missing geometry are not repaired
 * with invented connectors. Caller must verify SHA-256 of the downloaded bytes.
 */
export function buildNetwork(payload: OsmPayload, provenance: SourceProvenance): Network {
  if (!payload || !Array.isArray(payload.elements) || !payload.elements.length || payload.remark) throw new Error('완전한 OSM 원본 자료를 불러오지 못했습니다.');
  const checked = checkedProvenance(provenance, payload);
  const [south, west, north, east] = checked.bbox;
  const bounds: Network['bounds'] = [[west, south], [east, north]];
  const rawNodes = new Map<number, OsmElement>();
  const rawWays = new Map<number, OsmElement>();
  for (const element of payload.elements) {
    if (!Number.isSafeInteger(element.id) || element.id <= 0) continue;
    const store = element.type === 'node' ? rawNodes : element.type === 'way' ? rawWays : null;
    if (!store) continue;
    const existing = store.get(element.id);
    store.set(element.id, { ...existing, ...element, tags: { ...normalizedTags(existing?.tags), ...normalizedTags(element.tags) } });
  }
  const knownNodes = new Map<string, WalkNode>();
  for (const [id, element] of rawNodes) {
    if (!Number.isFinite(element.lon) || !Number.isFinite(element.lat)) continue;
    const coordinate: Coordinate = [element.lon!, element.lat!];
    if (!coordinateInside(coordinate, bounds)) continue;
    knownNodes.set(`node/${id}`, { id: `node/${id}`, coordinate, tags: normalizedTags(element.tags) });
  }
  const blocked = new Set([...knownNodes.values()].filter(node => !isNodePassable(node.tags)).map(node => node.id));
  const exclusions: Network['exclusions'] = { inaccessibleWays: 0, blockedNodes: blocked.size, blockedSegments: 0, outsideOrMissingSegments: 0, unsnappedPlaces: 0 };
  const segments: WalkSegment[] = [];
  const connectedNodes = new Set<string>();
  for (const element of rawWays.values()) {
    const tags = normalizedTags(element.tags);
    if (!tags.highway) continue;
    const direction = footDirection(tags);
    if (!isFootAccessible(tags) || direction === null || tags['oneway:foot:conditional'] || !Array.isArray(element.nodes)) {
      exclusions.inaccessibleWays += 1; continue;
    }
    const slope = inclinePercent(tags);
    const stairs = stairsStatus(tags);
    for (let index = 0; index < element.nodes.length - 1; index++) {
      const from = `node/${element.nodes[index]}`;
      const to = `node/${element.nodes[index + 1]}`;
      const a = knownNodes.get(from); const b = knownNodes.get(to);
      if (!a || !b) { exclusions.outsideOrMissingSegments += 1; continue; }
      if (blocked.has(from) || blocked.has(to)) { exclusions.blockedSegments += 1; continue; }
      const lengthM = distanceBetween(a.coordinate, b.coordinate);
      if (from === to || lengthM <= 0) continue;
      segments.push({
        id: `way/${element.id}:${index}`, wayId: String(element.id), from, to,
        name: tags['name:ko'] || tags.name || '이름이 등록되지 않은 OSM 구간',
        coordinates: [a.coordinate, b.coordinate], lengthM, slope, stairs, direction,
        source: `https://www.openstreetmap.org/way/${element.id}`, tags,
      });
      connectedNodes.add(from); connectedNodes.add(to);
    }
  }
  const nodes = [...connectedNodes].map(id => knownNodes.get(id)!);
  if (!segments.length || !nodes.length) throw new Error('수집 범위 안에서 이용 가능한 OSM 보행 구간을 찾지 못했습니다.');
  const network: Network = { nodes, segments, places: [], bounds, source: checked.source, provenance: checked, exclusions,
    shadingBuildings: buildingsWithHeight(rawNodes, rawWays.values()),
    placeCounts: { osmNamedPlaces: 0, osmSubwayEntrances: 0, officialSubwayEntrances: 0, total: 0 } };
  const candidates: { element: OsmElement; coordinate: Coordinate; type: 'node' | 'way' }[] = [];
  for (const element of rawNodes.values()) {
    const tags = normalizedTags(element.tags);
    if (!(tags['name:ko'] || tags.name) || !Number.isFinite(element.lon) || !Number.isFinite(element.lat)) continue;
    candidates.push({ element, coordinate: [element.lon!, element.lat!], type: 'node' });
  }
  for (const element of rawWays.values()) {
    const tags = normalizedTags(element.tags);
    if (!(tags['name:ko'] || tags.name) || tags.highway || !element.nodes?.length) continue;
    const ids = [...new Set(element.nodes)];
    const coordinates = ids.map(id => rawNodes.get(id)).filter((node): node is OsmElement => !!node && Number.isFinite(node.lon) && Number.isFinite(node.lat));
    if (coordinates.length !== ids.length) continue;
    // Actual feature geometry's vertex mean, explicitly labelled as a center,
    // not an entrance or a measured pedestrian connection.
    const coordinate: Coordinate = [coordinates.reduce((sum, node) => sum + node.lon!, 0) / coordinates.length, coordinates.reduce((sum, node) => sum + node.lat!, 0) / coordinates.length];
    candidates.push({ element, coordinate, type: 'way' });
  }
  for (const { element, coordinate, type } of candidates) {
    const snap = nearestNode(network, coordinate);
    if (!snap) { exclusions.unsnappedPlaces += 1; continue; }
    const tags = normalizedTags(element.tags);
    const place: Place = {
      id: `${type}/${element.id}`, sourceId: String(element.id), sourceType: type,
      sourceUrl: `https://www.openstreetmap.org/${type}/${element.id}`,
      name: tags['name:ko'] || tags.name, category: categoryFor(tags, type), coordinate,
      nodeId: snap.node.id, routeCoordinate: snap.node.coordinate, snapDistanceM: snap.distanceM,
      aliases: [...new Set(['alt_name', 'alt_name:ko', 'name:en', 'official_name', 'official_name:ko']
        .flatMap(key => (tags[key] ?? '').split(';')).map(value => value.trim()).filter(Boolean))],
    };
    network.places.push(place);
  }
  network.places.sort((a, b) => a.name.localeCompare(b.name, 'ko-KR') || a.id.localeCompare(b.id));
  network.placeCounts.osmNamedPlaces = network.places.length;
  network.placeCounts.total = network.places.length;
  return network;
}

/**
 * Attach actual entrance POIs missing from the original named-object extraction.
 * This never adds graph nodes/edges, edits osm.json, infers underground paths,
 * or treats a nearest-node gap as a verified sidewalk access route.
 */
export function addOsmSubwayEntrances(network: Network, source: OsmEntranceDataset): Network {
  if (!source || source.sourceSha256 !== network.provenance.sourceFileSha256
    || source.osmTimestamp !== network.provenance.osmTimestamp
    || !/^[a-f0-9]{64}$/.test(source.sourceRecordsSha256 ?? '')
    || !Number.isFinite(Date.parse(source.extractedAt)) || !Array.isArray(source.nodes) || !Array.isArray(source.relations)) {
    throw new Error('지하철 출입구 원본과 보행망의 출처가 일치하지 않습니다.');
  }
  const relation = source.relations.find(item => item.id === source.selection?.relationId && item.type === 'relation');
  const stationName = relation?.tags['name:ko'] || relation?.tags.name;
  if (!relation || relation.tags.public_transport !== 'stop_area' || !stationName) throw new Error('지하철 출입구의 원본 역 관계를 확인할 수 없습니다.');
  const members = new Set(relation.members.filter(member => member.type === 'node').map(member => member.ref));
  const expected = new Set(source.selection.nodeIds);
  const places = [...network.places];
  const existingIds = new Set(places.map(place => place.id));
  const report: NonNullable<Network['entranceConnections']> = { sourceRecordCount: source.nodes.length, added: 0, duplicateIds: 0, outsideBounds: 0, unconnected: [] };
  for (const node of source.nodes) {
    const exitNumber = node.tags?.ref;
    if (node.type !== 'node' || !Number.isSafeInteger(node.id) || !expected.has(node.id) || !members.has(node.id)
      || node.tags.railway !== 'subway_entrance' || !exitNumber || !/^\d+(?:-\d+)?$/.test(exitNumber)
      || node.tags.description !== `${stationName}역 ${exitNumber}번출구`
      || !Number.isFinite(Date.parse(node.timestamp)) || !Number.isFinite(node.lon) || !Number.isFinite(node.lat)) {
      throw new Error('지하철 출입구의 원문 번호·설명·역 소속을 확인할 수 없습니다.');
    }
    const id = `node/${node.id}`;
    if (existingIds.has(id)) { report.duplicateIds++; continue; }
    const coordinate: Coordinate = [node.lon, node.lat];
    if (!coordinateInside(coordinate, network.bounds)) { report.outsideBounds++; continue; }
    if (!isNodePassable(node.tags)) { report.unconnected.push({ sourceId: String(node.id), reason: '출입 접근권한을 확인할 수 없음' }); continue; }
    const snap = nearestNode(network, coordinate);
    if (!snap) { report.unconnected.push({ sourceId: String(node.id), reason: '80m 이내 실제 도보망 연결점 없음' }); continue; }
    places.push({ id, name: node.tags.description, category: '지하철 출입구 · OSM', coordinate,
      nodeId: snap.node.id, routeCoordinate: snap.node.coordinate, snapDistanceM: snap.distanceM,
      sourceType: 'node', sourceId: String(node.id), sourceUrl: `https://www.openstreetmap.org/node/${node.id}`,
      aliases: [stationName], entrance: { exitNumber, stationRelationId: String(relation.id), stationName, sourceTimestamp: node.timestamp, wheelchair: node.tags.wheelchair ?? null },
    });
    existingIds.add(id); report.added++;
  }
  places.sort((a,b) => a.name.localeCompare(b.name, 'ko-KR') || a.id.localeCompare(b.id));
  return { ...network, places, entranceConnections: report,
    placeCounts: { osmNamedPlaces: places.filter(place => !place.entrance).length, osmSubwayEntrances: places.filter(place => !!place.entrance).length, officialSubwayEntrances: 0, total: places.length },
    subwayEntranceSource: { source: source.source, endpoint: source.endpoint, osmTimestamp: source.osmTimestamp, extractedAt: source.extractedAt,
      sourceSha256: source.sourceSha256, sourceRecordsSha256: source.sourceRecordsSha256, license: source.license, licenseUrl: source.licenseUrl },
  };
}
