import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRisk, findForecastDetour, findPlaces, nearestPlace, searchRoutes } from './engine';
import { estimateBuildingShade } from './icing-forecast';
import { buildNetwork, coordinateInside, distanceBetween, geometryLength } from './network';
import { expireResult } from './resultLifecycle';
import type { OsmElement, OsmPayload, Place, SearchOptions, ShadeSurface, ShadingBuilding, SourceProvenance } from './types';
import { gangnamDemoPlaces, maljukgeoriFootbridge, maljukgeoriHeatedWarnings } from '../gangnam-pilot';
import { findIcingHours, readIcingReplay } from '../services/icing-weather';

// These tests use the checked-in, independently sourced OSM snapshot itself.
// No synthetic graph, risk labels, weather readings or coordinates are created.
const rawText = readFileSync(new URL('../../public/data/osm.json', import.meta.url), 'utf8');
const payload = JSON.parse(rawText) as OsmPayload;
const provenance = JSON.parse(readFileSync(new URL('../../public/data/provenance.json', import.meta.url), 'utf8')) as SourceProvenance;
const network = buildNetwork(payload, provenance);
const rawNodes = new Map(payload.elements.filter(element => element.type === 'node').map(element => [element.id, element]));
const rawWays = new Map(payload.elements.filter(element => element.type === 'way').map(element => [element.id, element]));
const connected = new Map(network.nodes.map(node => [node.id, node]));

function actualEndpoint(nodeId: string): Place {
  const node = connected.get(nodeId)!;
  const place = nearestPlace(network, node.coordinate);
  if (!place) throw new Error(`Actual graph node was not selectable: ${nodeId}`);
  // Coincident OSM nodes are deliberately NOT merged. Select this exact source node.
  return { ...place, nodeId: node.id, routeCoordinate: node.coordinate, snapDistanceM: 0 };
}

function optionsBetween(origin: Place, destination: Place): SearchOptions {
  return { origin, destination, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null };
}

const firstTwoWay = network.segments.find(segment => segment.direction === 'both')!;
const sourceOptions = optionsBetween(actualEndpoint(firstTwoWay.from), actualEndpoint(firstTwoWay.to));

it('applies the real Gangnam snowfall and installation records without removing the bridge warning', async () => {
  const files = new URL('../../public/data/gangnam/', import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, files), 'utf8');
  const graph = buildNetwork(JSON.parse(read('osm.json')), JSON.parse(read('provenance.json')));
  const buildings = JSON.parse(read('buildings.json')) as { buildings: ShadingBuilding[] };
  const surface = JSON.parse(read('surface.json')) as ShadeSurface;
  const gangnam = { ...graph, expandedShadingBuildings: buildings.buildings, shadeSurface: surface };
  const weather = read('icing-replay.json');
  const hour = await readIcingReplay(new TextEncoder().encode(weather).buffer, 'gangnam');
  const { sections } = estimateBuildingShade(gangnam, hour.time, true);
  const heated = maljukgeoriHeatedWarnings(gangnam, sections, hour);
  const bridge = gangnam.segments.find(segment => segment.wayId === maljukgeoriFootbridge.osmWayId)!;
  expect([...heated]).toEqual([bridge.id]);
  const warningIds = new Set(sections.map(section => section.segmentId));
  expect(warningIds.has(bridge.id)).toBe(true);

  const options = optionsBetween(gangnam.places.find(place => place.id === gangnamDemoPlaces.origin)!,
    gangnam.places.find(place => place.id === gangnamDemoPlaces.destination)!);
  const result = searchRoutes(gangnam, options);
  const baseline = findForecastDetour(gangnam, options, result, warningIds);
  const compared = findForecastDetour(gangnam, options, result, warningIds, heated);
  expect(result.normal?.segmentIds).toContain(bridge.id);
  expect(compared.crossings).toBe(5);
  expect(compared.route?.segmentIds).toEqual(baseline.route?.segmentIds);
  expect(compared.route?.segmentIds.every(id => !warningIds.has(id))).toBe(true);
  const normalWarningLength = gangnam.segments.filter(segment => warningIds.has(segment.id) && result.normal!.segmentIds.includes(segment.id))
    .reduce((total, segment) => total + segment.lengthM, 0);
  expect(compared.heatingComparison?.normal).toBeCloseTo(normalWarningLength - 0.2 * bridge.lengthM);
  expect(compared.heatingComparison?.alternate).toBe(0);

  const dryHour = findIcingHours(JSON.parse(weather), hour.time).find(item => item.time === hour.time + 2 * 3_600_000)!;
  expect(dryHour.temperatureC).toBeLessThan(0);
  const laterSections = estimateBuildingShade(gangnam, dryHour.time, true).sections;
  expect(maljukgeoriHeatedWarnings(gangnam, laterSections, dryHour).size).toBe(0);
});

// Independent unweighted reachability oracle for every actual named POI pair.
// Dijkstra is additionally checked on geographically separated reachable pairs.
const adjacency = new Map(network.nodes.map(node => [node.id, [] as string[]]));
for (const segment of network.segments) {
  if (segment.direction !== 'backward') adjacency.get(segment.from)!.push(segment.to);
  if (segment.direction !== 'forward') adjacency.get(segment.to)!.push(segment.from);
}
const reachability = new Map<string, Set<string>>();
function reachableFrom(nodeId: string): Set<string> {
  const cached = reachability.get(nodeId);
  if (cached) return cached;
  const visited = new Set([nodeId]); const queue = [nodeId];
  for (let index = 0; index < queue.length; index++) {
    for (const next of adjacency.get(queue[index]) ?? []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  reachability.set(nodeId, visited); return visited;
}
let reachableNamedPairs = 0;
let disconnectedNamedPairs = 0;
let sameNodeNamedPairs = 0;
const representativePairs: { origin: Place; destination: Place; directDistance: number }[] = [];
for (const origin of network.places) {
  const reachable = reachableFrom(origin.nodeId);
  let farthest: { origin: Place; destination: Place; directDistance: number } | null = null;
  for (const destination of network.places) {
    if (origin.id === destination.id) continue;
    if (origin.nodeId === destination.nodeId) { sameNodeNamedPairs++; continue; }
    if (!reachable.has(destination.nodeId)) { disconnectedNamedPairs++; continue; }
    reachableNamedPairs++;
    const directDistance = distanceBetween(origin.routeCoordinate, destination.routeCoordinate);
    if (!farthest || directDistance > farthest.directDistance) farthest = { origin, destination, directDistance };
  }
  if (farthest) representativePairs.push(farthest);
}
representativePairs.sort((a, b) => b.directDistance - a.directDistance);

describe('actual OSM source and topology', () => {
  it('matches the real source file checksum and preserves timestamps/licensing', () => {
    expect(createHash('sha256').update(rawText).digest('hex')).toBe(provenance.sha256);
    expect(network.provenance.osmTimestamp).toBe(provenance.osmTimestamp);
    expect(network.provenance.license).toBe(provenance.license);
    expect(network.provenance.source).toBe(provenance.source);
    expect(network.nodes.length).toBeGreaterThan(0);
    expect(network.segments.length).toBeGreaterThan(0);
  });

  it('uses original node identifiers and exact source coordinates, never geometric intersection nodes', () => {
    for (const node of network.nodes) {
      const original = rawNodes.get(Number(node.id.slice('node/'.length)))!;
      expect(original).toBeDefined();
      expect(node.coordinate).toEqual([original.lon, original.lat]);
      expect(coordinateInside(node.coordinate, network.bounds)).toBe(true);
    }
  });

  it('creates every edge from consecutive nodes of its original way without bridging gaps', () => {
    for (const segment of network.segments) {
      const original = rawWays.get(Number(segment.wayId))!;
      const sequence = Number(segment.id.split(':').at(-1));
      expect(segment.from).toBe(`node/${original.nodes![sequence]}`);
      expect(segment.to).toBe(`node/${original.nodes![sequence + 1]}`);
      expect(segment.coordinates).toEqual([connected.get(segment.from)!.coordinate, connected.get(segment.to)!.coordinate]);
      expect(segment.lengthM).toBeCloseTo(geometryLength(segment.coordinates), 8);
      expect(segment.source).toBe(`https://www.openstreetmap.org/way/${original.id}`);
    }
  });

  it('does not introduce unsupported permissions or pedestrian directions', () => {
    const prohibited = new Set(['no', 'private', 'customers', 'delivery', 'destination', 'permit', 'agricultural', 'forestry', 'use_sidepath']);
    const permitted = new Set(['yes', 'designated', 'permissive', 'official', 'public']);
    for (const segment of network.segments) {
      const tags = segment.tags;
      expect(prohibited.has(tags.foot)).toBe(false);
      if (!permitted.has(tags.foot)) expect(prohibited.has(tags.access)).toBe(false);
      expect(tags['access:conditional']).toBeUndefined();
      expect(tags['foot:conditional']).toBeUndefined();
      expect(tags['oneway:foot:conditional']).toBeUndefined();
      if (['yes', 'true', '1'].includes(tags['oneway:foot'])) expect(segment.direction).toBe('forward');
      if (['-1', 'reverse'].includes(tags['oneway:foot'])) expect(segment.direction).toBe('backward');
      for (const id of [segment.from, segment.to]) {
        const nodeTags = connected.get(id)!.tags;
        if (nodeTags.barrier && !['no', 'entrance'].includes(nodeTags.barrier)) expect(permitted.has(nodeTags.foot)).toBe(true);
      }
    }
  });

  it('leaves unrecorded incline and stairs unknown instead of manufacturing accessible roads', () => {
    const withoutIncline = network.segments.filter(segment => !segment.tags.incline);
    expect(withoutIncline.length).toBeGreaterThan(0);
    for (const segment of withoutIncline) expect(segment.slope).toBeNull();
    const withoutStairsEvidence = network.segments.filter(segment => segment.tags.highway !== 'steps' && !segment.tags.stairs && !segment.tags.steps && !segment.tags.step_count);
    expect(withoutStairsEvidence.length).toBeGreaterThan(0);
    for (const segment of withoutStairsEvidence) expect(segment.stairs).toBeNull();
    for (const segment of network.segments.filter(segment => segment.tags.highway === 'steps')) expect(segment.stairs).toBe(true);
    for (const segment of network.segments) {
      expect('shade' in segment).toBe(false);
      expect('moisture' in segment).toBe(false);
    }
  });
});

describe('real source place search and snapping', () => {
  it('only lists names in the actual OSM elements and discloses snap gaps', () => {
    expect(network.places.length).toBeGreaterThan(0);
    for (const place of network.places) {
      const original = (place.sourceType === 'node' ? rawNodes : rawWays).get(Number(place.sourceId)) as OsmElement;
      expect(place.name).toBe(original.tags?.['name:ko'] || original.tags?.name);
      expect(place.sourceUrl).toBe(`https://www.openstreetmap.org/${place.sourceType}/${place.sourceId}`);
      expect(place.routeCoordinate).toEqual(connected.get(place.nodeId)!.coordinate);
      expect(place.snapDistanceM).toBeCloseTo(distanceBetween(place.coordinate, place.routeCoordinate), 8);
      expect(place.snapDistanceM).toBeLessThanOrEqual(80);
      if (place.sourceType === 'node') expect(place.coordinate).toEqual([original.lon, original.lat]);
      else expect(place.category).toContain('도형 중심');
    }
  });

  it('finds a real registered name and returns no made-up fallback when it is absent', () => {
    const actual = network.places[0];
    expect(findPlaces(network, actual.name).some(place => place.id === actual.id)).toBe(true);
    expect(findPlaces(network, '__not_an_osm_place__')).toEqual([]);
    expect(findPlaces(network, '').every(place => network.places.includes(place))).toBe(true);
  });

  it('distinguishes the real station and government building from same-name shops, stops and junctions', () => {
    const actualStation = network.places.find(place => place.name === '서울대입구' && place.category === '철도 · station');
    const actualOffice = network.places.find(place => place.name === '관악구청' && place.category.startsWith('기관 · government'));
    expect(actualStation).toBeDefined();
    expect(actualOffice).toBeDefined();
    expect(findPlaces(network, '서울대입구역')[0].id).toBe(actualStation!.id);
    expect(findPlaces(network, '관악구청')[0].id).toBe(actualOffice!.id);
  });

  it('refuses actual source nodes outside the collected service bounds', () => {
    const outside = [...rawNodes.values()].find(node => Number.isFinite(node.lon) && Number.isFinite(node.lat)
      && !coordinateInside([node.lon!, node.lat!], network.bounds));
    expect(outside).toBeDefined();
    expect(nearestPlace(network, [outside!.lon!, outside!.lat!])).toBeNull();
  });
});

describe('actual graph routing without invented icing recommendations', () => {
  it('diagnoses directed connectivity of every actual named place pair', () => {
    expect(reachableNamedPairs + disconnectedNamedPairs + sameNodeNamedPairs).toBe(network.places.length * (network.places.length - 1));
    expect(reachableNamedPairs).toBeGreaterThan(0);
    console.info('Actual OSM named-place connectivity', JSON.stringify({
      sourceTimestamp: provenance.osmTimestamp, nodes: network.nodes.length, segments: network.segments.length,
      namedPlaces: network.places.length, reachableOrderedPairs: reachableNamedPairs,
      disconnectedOrderedPairs: disconnectedNamedPairs, sameNodeOrderedPairs: sameNodeNamedPairs,
      exclusions: network.exclusions,
      sourceTagCoverage: {
        knownInclineSegments: network.segments.filter(segment => segment.slope !== null).length,
        knownStairsSegments: network.segments.filter(segment => segment.stairs === true).length,
        explicitlyNoStairsSegments: network.segments.filter(segment => segment.stairs === false).length,
        unknownStairsSegments: network.segments.filter(segment => segment.stairs === null).length,
        pedestrianOneWaySegments: network.segments.filter(segment => segment.direction !== 'both').length,
      },
    }));
  });

  it('finds multi-edge routes for separated real named POIs and preserves the complete source topology', () => {
    const sampled = representativePairs.slice(0, 24);
    expect(sampled.length).toBeGreaterThan(0);
    expect(sampled[0].directDistance).toBeGreaterThan(100);
    for (const { origin, destination } of sampled) {
      const result = searchRoutes(network, optionsBetween(origin, destination));
      expect(result.status).toBe('no-recommendation');
      const route = result.normal!;
      expect(route).not.toBeNull();
      expect(route.segmentIds.length).toBeGreaterThan(1);
      expect(route.coordinates[0]).toEqual(origin.routeCoordinate);
      expect(route.coordinates.at(-1)).toEqual(destination.routeCoordinate);
      expect(route.distanceM).toBeCloseTo(geometryLength(route.coordinates), 7);
      expect(route.distanceM).toBeGreaterThanOrEqual(distanceBetween(origin.routeCoordinate, destination.routeCoordinate) - 0.001);
      expect(route.steps.reduce((sum, step) => sum + step.durationSeconds, 0)).toBeCloseTo(route.durationSeconds, 7);
      let cursor = origin.nodeId;
      for (const id of route.segmentIds) {
        const segment = network.segments.find(segment => segment.id === id)!;
        if (cursor === segment.from) { expect(segment.direction).not.toBe('backward'); cursor = segment.to; }
        else { expect(cursor).toBe(segment.to); expect(segment.direction).not.toBe('forward'); cursor = segment.from; }
      }
      expect(cursor).toBe(destination.nodeId);
    }
  });

  it('reports Seoul National University Station to Gwanak Office using source POIs when present', () => {
    const station = network.places.find(place => place.name.includes('서울대입구') && place.category.includes('철도'))
      ?? network.places.find(place => place.name.includes('서울대입구'));
    const office = network.places.find(place => place.name === '관악구청' && place.category.includes('기관 · government'));
    if (!station || !office) {
      console.info('Actual target-place coverage', JSON.stringify({ stationFound: !!station, officeFound: !!office }));
      return; // Absence is reported; an invented replacement is never inserted.
    }
    const result = searchRoutes(network, optionsBetween(station, office));
    const reachable = station.nodeId !== office.nodeId && reachableFrom(station.nodeId).has(office.nodeId);
    expect(!!result.normal).toBe(reachable);
    if (result.normal) {
      expect(result.normal.segmentIds.length).toBeGreaterThan(1);
      expect(result.normal.coordinates[0]).toEqual(station.routeCoordinate);
      expect(result.normal.coordinates.at(-1)).toEqual(office.routeCoordinate);
    }
    console.info('Actual station-office route', JSON.stringify({ origin: station.name, originSource: station.sourceUrl,
      destination: office.name, destinationSource: office.sourceUrl, status: result.status,
      distanceM: result.normal?.distanceM ?? null, secondsAtOneMeterPerSecond: result.normal?.durationSeconds ?? null,
      segmentCount: result.normal?.segmentIds.length ?? 0, originGapM: station.snapDistanceM, destinationGapM: office.snapDistanceM,
    }));
  });

  it('keeps every segment unknown and refuses to attach a fake analysis validity period', () => {
    const run = analyzeRisk(network);
    expect(run.method).toBe('no-icing-observations');
    expect(run.validUntil).toBeNull();
    expect(run.temperatureC).toBeNull();
    expect(run.precipitationMm).toBeNull();
    expect(run.estimates).toHaveLength(network.segments.length);
    expect(run.estimates.every(risk => risk.level === 'unknown' && risk.score === null && risk.dataStatus === 'missing')).toBe(true);
  });

  it('computes a contiguous ordinary route on an existing real source segment', () => {
    const result = searchRoutes(network, sourceOptions);
    expect(result.status).toBe('no-recommendation');
    expect(result.recommended).toBeNull();
    expect(result.extraSeconds).toBeNull();
    expect(result.normal).not.toBeNull();
    const route = result.normal!;
    expect(route.coordinates[0]).toEqual(sourceOptions.origin!.routeCoordinate);
    expect(route.coordinates.at(-1)).toEqual(sourceOptions.destination!.routeCoordinate);
    expect(route.distanceM).toBeCloseTo(geometryLength(route.coordinates), 7);
    expect(route.durationSeconds).toBeCloseTo(route.distanceM / sourceOptions.walkingSpeedMps, 7);
    expect(route.unknownCount).toBe(route.segmentIds.length);
    expect(route.highRiskCount).toBe(0);
    for (const id of route.segmentIds) expect(network.segments.some(segment => segment.id === id)).toBe(true);
  });

  it('respects orientation when reversing an actual bidirectional source edge', () => {
    const forward = searchRoutes(network, sourceOptions).normal!;
    const reverse = searchRoutes(network, { ...sourceOptions, origin: sourceOptions.destination, destination: sourceOptions.origin }).normal!;
    expect(reverse.coordinates).toEqual([...forward.coordinates].reverse());
    expect(reverse.distanceM).toBeCloseTo(forward.distanceM, 8);
  });

  it('derives duration from chosen walking speed without inventing endpoints or weather', () => {
    const first = searchRoutes(network, sourceOptions).normal!;
    const slower = searchRoutes(network, { ...sourceOptions, walkingSpeedMps: 0.5 }).normal!;
    expect(slower.segmentIds).toEqual(first.segmentIds);
    expect(slower.durationSeconds).toBeCloseTo(first.durationSeconds * 2, 8);
  });

  it('never passes unknown stair or slope metadata under explicit accessibility filters', () => {
    for (const settings of [{ avoidStairs: true }, { maxSlopePercent: 5 }]) {
      const result = searchRoutes(network, { ...sourceOptions, ...settings });
      expect(['no-route', 'no-recommendation']).toContain(result.status);
      if (result.normal) for (const id of result.normal.segmentIds) {
        const segment = network.segments.find(segment => segment.id === id)!;
        if (settings.avoidStairs) expect(segment.stairs).toBe(false);
        if (settings.maxSlopePercent !== undefined) {
          expect(segment.slope).not.toBeNull();
          expect(Math.abs(segment.slope!)).toBeLessThanOrEqual(settings.maxSlopePercent);
        }
      }
    }
  });

  it('does not expire real ordinary routes using a fabricated icing timestamp', () => {
    const result = searchRoutes(network, sourceOptions);
    expect(expireResult(result, Date.now())).toBe(result);
  });

  it('rejects incomplete input and identical graph endpoints', () => {
    expect(searchRoutes(network, { ...sourceOptions, origin: null }).status).toBe('invalid-input');
    expect(searchRoutes(network, { ...sourceOptions, destination: sourceOptions.origin }).status).toBe('invalid-input');
    expect(searchRoutes(network, { ...sourceOptions, walkingSpeedMps: 0 }).status).toBe('invalid-input');
  });
});
