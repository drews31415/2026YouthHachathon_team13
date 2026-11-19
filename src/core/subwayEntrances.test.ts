import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import source from '../subway-entrances.json';
import { addOsmSubwayEntrances, buildNetwork, coordinateInside, distanceBetween, geometryLength } from './network';
import { findPlaces, searchRoutes } from './engine';
import type { OsmPayload, SourceProvenance } from './types';

const rawRoads = readFileSync(new URL('../../public/data/osm.json', import.meta.url), 'utf8');
const provenance = JSON.parse(readFileSync(new URL('../../public/data/provenance.json', import.meta.url), 'utf8')) as SourceProvenance;
const base = buildNetwork(JSON.parse(rawRoads) as OsmPayload, provenance);
const network = addOsmSubwayEntrances(base, source);
const entrances = network.places.filter(place => place.entrance);
const rawEntranceSource = readFileSync(new URL('../../../data/subway-osm-entrances-source.json', import.meta.url), 'utf8');
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
    expect(base.places).toHaveLength(902);
    expect(network.placeCounts).toEqual({ osmNamedPlaces: 902, osmSubwayEntrances: 8, officialSubwayEntrances: 0, total: 910 });
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
    expect(repeated.places).toHaveLength(910);
    expect(new Set(repeated.places.map(place => place.id)).size).toBe(910);
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
    const office = base.places.find(place => place.name === '관악구청' && place.category.includes('기관 · government'))!;
    expect(office).toBeDefined();
    const results = entrances.map(place => {
      const actualNode = base.nodes.find(node => node.id === place.nodeId)!;
      expect(place.routeCoordinate).toEqual(actualNode.coordinate);
      expect(place.snapDistanceM).toBeCloseTo(distanceBetween(place.coordinate, actualNode.coordinate), 8);
      expect(place.snapDistanceM).toBeLessThanOrEqual(80);
      const result = searchRoutes(network, { origin: place, destination: office, walkingSpeedMps: 1, avoidStairs: false, maxSlopePercent: null });
      expect(['no-route', 'no-recommendation']).toContain(result.status);
      if (result.normal) {
        expect(result.normal.coordinates[0]).toEqual(place.routeCoordinate);
        expect(result.normal.coordinates.at(-1)).toEqual(office.routeCoordinate);
        expect(result.normal.distanceM).toBeCloseTo(geometryLength(result.normal.coordinates), 7);
        expect(result.normal.durationSeconds).toBeCloseTo(result.normal.distanceM, 7);
        expect(result.normal.segmentIds.every(id => base.segments.some(segment => segment.id === id))).toBe(true);
      }
      expect(result.recommended).toBeNull();
      return { exit: place.entrance!.exitNumber, sourceId: place.sourceId, gapM: place.snapDistanceM, nodeId: place.nodeId, status: result.status, roadDistanceToOfficeM: result.normal?.distanceM ?? null };
    });
    expect(network.entranceConnections!.unconnected).toEqual([]);
    expect(results.filter(result => result.roadDistanceToOfficeM !== null)).toHaveLength(8);
    console.info('Actual OSM subway entrances', JSON.stringify({ counts: network.placeCounts, connections: network.entranceConnections, results }));
  });
});
