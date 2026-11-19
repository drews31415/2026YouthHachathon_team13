import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import source from '../subway-entrances.json';
import { addOsmSubwayEntrances, buildNetwork, coordinateInside, distanceBetween, geometryLength } from './network';
import { findForecastDetour, findPlaces, searchRoutes } from './engine';
import { estimateBuildingShade } from './icing-forecast';
import { readIcingReplay } from '../services/icing-weather';
import type { OsmPayload, SourceProvenance } from './types';

const rawRoads = readFileSync(new URL('../../public/data/osm.json', import.meta.url), 'utf8');
const provenance = JSON.parse(readFileSync(new URL('../../public/data/provenance.json', import.meta.url), 'utf8')) as SourceProvenance;
const base = buildNetwork(JSON.parse(rawRoads) as OsmPayload, provenance);
const network = addOsmSubwayEntrances(base, source);
const entrances = network.places.filter(place => place.entrance);
const rawEntranceSource = readFileSync(new URL('./testdata/subway-entrances-source.json', import.meta.url), 'utf8');
const independentlyExtracted = JSON.parse(rawEntranceSource);

describe('actual supplemental OSM subway entrance records', () => {
  it('matches independently extracted records and leaves the original road snapshot unchanged', () => {
    expect(createHash('sha256').update(rawEntranceSource).digest('hex')).toBe(source.sourceRecordsSha256);
    expect(source.nodes).toEqual(independentlyExtracted.nodes);
    expect(source.relations).toEqual(independentlyExtracted.relations);
    expect(source.sourceSha256).toBe(provenance.sourceFileSha256);
    expect(createHash('sha256').update(rawRoads).digest('hex')).toBe(provenance.sha256);
    expect(network.nodes).toBe(base.nodes);
    expect(network.segments).toBe(base.segments);
    expect(network.bounds).toEqual(base.bounds);
    expect(base.places).toHaveLength(379);
    expect(network.placeCounts).toEqual({ osmNamedPlaces: 379, osmSubwayEntrances: 8, officialSubwayEntrances: 0, total: 387 });
  });

  it('requires actual entrance tags, exit numbers and station relation membership', () => {
    expect(entrances).toHaveLength(8);
    expect(entrances.map(place => place.entrance!.exitNumber).sort()).toEqual(['1','2','3','4','5','6','7','8']);
    const relation = source.relations.find(item => item.id === 8469467)!;
    for (const place of entrances) {
      const node = source.nodes.find(item => String(item.id) === place.sourceId)!;
      expect(node.tags.railway).toBe('subway_entrance');
      expect(relation.members.some(member => member.type === 'node' && String(member.ref) === place.sourceId)).toBe(true);
      expect(place.name).toBe(node.tags.description);
      expect(place.entrance!.exitNumber).toBe(node.tags.ref);
      expect(place.entrance!.sourceTimestamp).toBe(node.timestamp);
      expect(place.coordinate).toEqual([node.lon, node.lat]);
      expect(coordinateInside(place.coordinate, base.bounds)).toBe(true);
      expect(place.sourceUrl).toBe(`https://www.openstreetmap.org/node/${node.id}`);
    }
  });

  it('deduplicates original node IDs without claiming duplicate official facilities', () => {
    const repeated = addOsmSubwayEntrances(network, source);
    expect(repeated.places).toHaveLength(network.places.length);
    expect(new Set(repeated.places.map(place => place.id)).size).toBe(network.places.length);
    expect(repeated.entranceConnections!.duplicateIds).toBe(8);
    expect(repeated.placeCounts.officialSubwayEntrances).toBe(0);
    expect(() => addOsmSubwayEntrances(base, { ...source, sourceSha256: '' })).toThrow();
    expect(() => addOsmSubwayEntrances(base, { ...source, relations: [] })).toThrow();
  });

  it('ranks the actual exit before a bicycle station or bus stop bearing the same name', () => {
    const fourth = entrances.find(place => place.entrance!.exitNumber === '4')!;
    for (const query of ['서울대입구역4번출구', '서울대입구역 4번출구', '서울대입구역 4번 출구', '서울대입구 역 4 번 출구']) {
      expect(findPlaces(network, query)[0].id).toBe(fourth.id);
    }
    expect(findPlaces(network, '서울대입구역')[0].category).toBe('철도 · station');
    expect(network.places.find(place => place.sourceId === '12372983070')?.entrance).toBeUndefined();
  });

  it('discloses every real entrance gap and never appends an unverified access line to the route', () => {
    const destination = entrances.find(place => place.entrance!.exitNumber === '5')!;
    for (const place of entrances) {
      const actualNode = base.nodes.find(node => node.id === place.nodeId)!;
      expect(place.routeCoordinate).toEqual(actualNode.coordinate);
      expect(place.snapDistanceM).toBeCloseTo(distanceBetween(place.coordinate, actualNode.coordinate), 8);
      expect(place.snapDistanceM).toBeLessThanOrEqual(80);
      if (place.nodeId === destination.nodeId) continue;
      const result = searchRoutes(network, { origin: place, destination, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null });
      expect(['no-route', 'no-recommendation']).toContain(result.status);
      if (result.normal) {
        expect(result.normal.coordinates[0]).toEqual(place.routeCoordinate);
        expect(result.normal.coordinates.at(-1)).toEqual(destination.routeCoordinate);
        expect(result.normal.distanceM).toBeCloseTo(geometryLength(result.normal.coordinates), 7);
        expect(result.normal.durationSeconds).toBeCloseTo(result.normal.distanceM, 7);
        expect(result.normal.segmentIds.every(id => base.segments.some(segment => segment.id === id))).toBe(true);
      }
      expect(result.recommended).toBeNull();
    }
    expect(network.entranceConnections!.unconnected).toEqual([]);
  });

  it('finds an actual forecast detour between separately mapped walkways and crossings', async () => {
    const archived = readFileSync(new URL('../../public/data/icing-replay.json', import.meta.url));
    const hour = await readIcingReplay(Uint8Array.from(archived).buffer, 'original');
    const warnings = new Set(estimateBuildingShade(network, hour.time).sections.map(section => section.segmentId));
    const origin = entrances.find(place => place.entrance!.exitNumber === '1')!;
    const destination = entrances.find(place => place.entrance!.exitNumber === '5')!;
    const options = { origin, destination, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null };
    const result = searchRoutes(network, options);
    const detour = findForecastDetour(network, options, result, warnings);
    expect(result.normal?.distanceM).toBeCloseTo(145.784, 2);
    expect(detour.route?.distanceM).toBeCloseTo(151.948, 2);
    expect(detour.route?.segmentIds.every(id => !warnings.has(id))).toBe(true);
    expect(detour.route?.segmentIds.some(id => network.segments.find(segment => segment.id === id)?.tags.footway === 'crossing')).toBe(true);
  });
});
