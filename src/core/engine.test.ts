import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeRisk, findForecastDetour, findHazardAvoidingRoute, findPlaces, nearestPlace, searchRoutes } from './engine';
import { estimateBuildingShade } from './icing-forecast';
import { addOsmSubwayEntrances, buildNetwork, coordinateInside, distanceBetween, geometryLength, isFootAccessible } from './network';
import { expireResult } from './resultLifecycle';
import type { OsmElement, OsmPayload, Place, SearchOptions, ShadeSurface, ShadingBuilding, SourceProvenance } from './types';
import { aifsDemoPlaces, gangnamDemoPlaces, heatedWalkWarnings, maljukgeoriFootbridge } from '../gangnam-pilot';
import { findIcingHours, hasRefreezeConditions, readIcingReplay } from '../services/icing-weather';

// The graph, coordinates and archived weather come from the checked-in sources.
const rawText = readFileSync(new URL('../../public/data/osm.json', import.meta.url), 'utf8');
const payload = JSON.parse(rawText) as OsmPayload;
const provenance = JSON.parse(readFileSync(new URL('../../public/data/provenance.json', import.meta.url), 'utf8')) as SourceProvenance;
const network = buildNetwork(payload, provenance);
const rawNodes = new Map(payload.elements.filter(element => element.type === 'node').map(element => [element.id, element]));
const rawWays = new Map(payload.elements.filter(element => element.type === 'way').map(element => [element.id, element]));
const connected = new Map(network.nodes.map(node => [node.id, node]));

it('evaluates shared walking and cycling paths in the expanded shade estimate', async () => {
  const raw = readFileSync(new URL('../../public/data/icing-snow-replay.json', import.meta.url));
  const hour = await readIcingReplay(Uint8Array.from(raw).buffer, 'snow');
  const sharedPaths = network.segments.filter(segment => segment.tags.highway === 'cycleway');
  const estimate = estimateBuildingShade({ ...network, segments: sharedPaths }, hour.time, true);
  expect(estimate.sections.length).toBeGreaterThan(0);
  expect(estimate.sections.every(section => sharedPaths.some(segment => segment.id === section.segmentId && isFootAccessible(segment.tags)))).toBe(true);
});

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

it('excludes icing, stairs and ramps in one search and returns no route when every alternative is blocked', async () => {
  const entrances = JSON.parse(readFileSync(new URL('../subway-entrances.json', import.meta.url), 'utf8'));
  const graph = addOsmSubwayEntrances(network, entrances);
  const origin = graph.places.find(place => place.id === 'node/3404830015')!;
  const destination = graph.places.find(place => place.id === 'node/3404830009')!;
  const options = optionsBetween(origin, destination);
  const archive = readFileSync(new URL('../../public/data/icing-replay.json', import.meta.url));
  const hour = await readIcingReplay(Uint8Array.from(archive).buffer, 'original');
  const icing = new Set(estimateBuildingShade(graph, hour.time).sections.map(section => section.segmentId));
  const result = searchRoutes(graph, options);
  const normal = result.normal!;
  expect(normal.segmentIds.some(id => icing.has(id))).toBe(true);
  const safe = findHazardAvoidingRoute(graph, options, result, icing)!;
  expect(safe.distanceM).toBeGreaterThan(normal.distanceM);
  expect(safe.segmentIds.some(id => icing.has(id))).toBe(false);

  // Keep the original graph and coordinates, then put each route hazard on the known alternative.
  const changed = safe.segmentIds.slice(0, 3);
  expect(changed).toHaveLength(3);
  const hazards = graph.segments.map(segment => {
    if (segment.id === changed[0]) return { ...segment, stairs: true };
    if (segment.id === changed[1]) return { ...segment, slope: -0.5 };
    if (segment.id === changed[2]) return { ...segment, tags: { ...segment.tags, ramp: 'yes' } };
    return segment;
  });
  const longer = findHazardAvoidingRoute({ ...graph, segments: hazards }, options, result, icing);
  expect(longer?.segmentIds ?? []).not.toEqual(safe.segmentIds);
  expect(longer?.segmentIds.some(id => changed.includes(id) || icing.has(id)) ?? false).toBe(false);
  const exits = graph.segments.filter(segment => segment.from === origin.nodeId || segment.to === origin.nodeId);
  expect(exits.length).toBeGreaterThan(0);
  expect(findHazardAvoidingRoute(graph, options, result, new Set(exits.map(segment => segment.id)))).toBeNull();
});

it('keeps the original route geometry on a flat or unmarked way and blocks directional inclines and explicit ramps', () => {
  const segment = { ...firstTwoWay, stairs: null, slope: null, tags: { highway: 'footway' } };
  const graph = { ...network, segments: [segment] };
  const result = searchRoutes(graph, sourceOptions);
  expect(result.normal?.segmentIds).toEqual([segment.id]);
  expect(findHazardAvoidingRoute(graph, sourceOptions, result, new Set())?.coordinates).toEqual(result.normal?.coordinates);
  const flat = { ...segment, slope: 0, tags: { ...segment.tags, incline: '0%', ramp: 'separate' } };
  expect(findHazardAvoidingRoute({ ...graph, segments: [flat] }, sourceOptions, result, new Set())?.segmentIds).toEqual([segment.id]);
  const hazardTags: Record<string, string>[] = [
    { incline: 'up' }, { incline: 'down' }, { incline: 'up/down' }, { footway: 'ramp' }, { ramp: 'yes' }, { ramp: 'wheelchair' },
  ];
  for (const tags of hazardTags) {
    const upgraded = { ...segment, tags: { ...segment.tags, ...tags } };
    expect(findHazardAvoidingRoute({ ...graph, segments: [upgraded] }, sourceOptions, result, new Set())).toBeNull();
  }
  for (const blocked of [{ ...segment, stairs: true }, { ...segment, slope: -0.5 }, { ...segment, slope: 0.5 }]) {
    expect(findHazardAvoidingRoute({ ...graph, segments: [blocked] }, sourceOptions, result, new Set())).toBeNull();
  }
});

const gangnamFile = (name: string) => readFileSync(new URL('../../public/data/gangnam/' + name, import.meta.url), 'utf8');
const gangnamPayload = JSON.parse(gangnamFile('osm.json')) as OsmPayload;
const gangnam = {
  ...buildNetwork(gangnamPayload, JSON.parse(gangnamFile('provenance.json'))),
  expandedShadingBuildings: (JSON.parse(gangnamFile('buildings.json')) as { buildings: ShadingBuilding[] }).buildings,
  shadeSurface: JSON.parse(gangnamFile('surface.json')) as ShadeSurface,
};

it('replays the archived AIFS forecast and avoids the six flagged segments around Yangjae Station', async () => {
  const raw = new TextEncoder().encode(gangnamFile('icing-aifs-replay.json')).buffer;
  const hour = await readIcingReplay(raw, 'aifs');
  expect(hour).toMatchObject({ time: Date.parse('2026-02-02T13:00:00+09:00'),
    temperatureC: -1, precedingPrecipMm: 0.2, recentSnowfall: true });
  expect(hasRefreezeConditions(hour)).toBe(true);
  const { sections } = estimateBuildingShade(gangnam, hour.time, true);
  const warnings = new Set(sections.map(section => section.segmentId));
  const options = optionsBetween(gangnam.places.find(place => place.id === aifsDemoPlaces.origin)!,
    gangnam.places.find(place => place.id === aifsDemoPlaces.destination)!);
  const result = searchRoutes(gangnam, options);
  const baseline = findHazardAvoidingRoute(gangnam, options, result, new Set());
  const alternate = findHazardAvoidingRoute(gangnam, options, result, warnings);
  expect(Math.round(result.normal?.distanceM ?? 0)).toBe(294);
  expect(baseline?.segmentIds).toEqual(result.normal?.segmentIds);
  expect(result.normal?.segmentIds.filter(id => warnings.has(id))).toHaveLength(6);
  expect(Math.round(alternate?.distanceM ?? 0)).toBe(360);
  expect(alternate?.segmentIds.filter(id => warnings.has(id))).toHaveLength(0);
});

it('keeps the real Gangnam bridge warning without accepting the former roadway detour', async () => {
  const weather = gangnamFile('icing-replay.json');
  const hour = await readIcingReplay(new TextEncoder().encode(weather).buffer, 'gangnam');
  const { sections } = estimateBuildingShade(gangnam, hour.time, true);
  const heated = heatedWalkWarnings(gangnam, sections, hour);
  const bridge = gangnam.segments.find(segment => segment.wayId === maljukgeoriFootbridge.osmWayId)!;
  const yangjaecheonBridge = gangnam.segments.find(segment => segment.wayId === '396143389')!;
  expect(yangjaecheonBridge.tags.bridge).toBe('yes');
  expect(heated).toEqual(new Set([bridge.id, yangjaecheonBridge.id]));
  expect(gangnam.segments.filter(segment => segment.wayId === '396143390' && heated.has(segment.id))).toHaveLength(0);
  const warningIds = new Set(sections.map(section => section.segmentId));
  expect(warningIds.has(bridge.id)).toBe(true);

  const options = optionsBetween(gangnam.places.find(place => place.id === gangnamDemoPlaces.origin)!,
    gangnam.places.find(place => place.id === gangnamDemoPlaces.destination)!);
  const result = searchRoutes(gangnam, options);
  const baseline = findForecastDetour(gangnam, options, result, warningIds);
  const compared = findForecastDetour(gangnam, options, result, warningIds, heated);
  expect(result.normal?.segmentIds).toContain(bridge.id);
  expect(result.normal?.distanceM).toBeCloseTo(591.648, 2);
  const formerRoadways = new Set([521770120, 494822058, 494822057, 218966989]);
  expect(gangnamPayload.elements.filter(item => item.type === 'way' && formerRoadways.has(item.id))).toHaveLength(formerRoadways.size);
  expect(gangnam.segments.some(segment => formerRoadways.has(Number(segment.wayId)))).toBe(false);
  expect(compared.crossings).toBeGreaterThan(0);
  expect(baseline.route).toBeNull();
  expect(compared.route).toBeNull();
  expect(findHazardAvoidingRoute(gangnam, options, result, warningIds)).toBeNull();
  const normalWarningLength = gangnam.segments.filter(segment => warningIds.has(segment.id) && result.normal!.segmentIds.includes(segment.id))
    .reduce((total, segment) => total + segment.lengthM, 0);
  expect(compared.heatingComparison?.normal.beforeHeating).toBeCloseTo(normalWarningLength);
  expect(compared.heatingComparison?.normal.afterHeating).toBeCloseTo(normalWarningLength - 0.2 * bridge.lengthM);
  expect(compared.heatingComparison?.alternate).toBeNull();

  const dryHour = findIcingHours(JSON.parse(weather), hour.time).find(item => item.time === hour.time + 2 * 3_600_000)!;
  expect(dryHour.temperatureC).toBeLessThan(0);
  const laterSections = estimateBuildingShade(gangnam, dryHour.time, true).sections;
  expect(heatedWalkWarnings(gangnam, laterSections, dryHour).size).toBe(0);
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

  it('excludes the real car road centerline even when it records sidewalks on both sides', () => {
    const road = rawWays.get(172606281)!;
    expect(road.tags?.sidewalk).toBe('both');
    expect(road.tags?.highway).toBe('residential');
    expect(isFootAccessible(road.tags!)).toBe(false);
    expect(network.segments.some(segment => segment.wayId === String(road.id))).toBe(false);
    expect(network.segments.some(segment => segment.tags.footway === 'crossing')).toBe(true);
    expect(network.segments.every(segment => ['footway', 'pedestrian', 'path', 'steps', 'cycleway'].includes(segment.tags.highway))).toBe(true);
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

  it('ranks the real station and excludes the government building when it cannot be connected', () => {
    const actualStation = network.places.find(place => place.name === '서울대입구' && place.category === '철도 · station');
    const actualOffice = network.places.find(place => place.name === '관악구청' && place.category.startsWith('기관 · government'));
    expect(actualStation).toBeDefined();
    expect(actualOffice).toBeUndefined();
    expect(findPlaces(network, '서울대입구역')[0].id).toBe(actualStation!.id);
    expect([...rawWays.values()].some(element => element.tags?.name === '관악구청' && element.tags?.office === 'government')).toBe(true);
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
