import { buildNetwork, coordinateInside } from '../core/network';
import type { Coordinate, Network, OsmElement, ShadeSurface, ShadingBuilding, SourceProvenance } from '../core/types';

type Index = Omit<SourceProvenance, 'sha256'> & { step: number; tiles: Record<string, string>; surfaceSha256: string; tileFormat: number };
type Tile = { n: string; w: string; b: string; t: Record<string, string>[] };
type SurfaceData = Omit<ShadeSurface, 'elevation'> & { deltas: string; unitsPerMeter: number };
const directory = '/data/seoul/';

function decode(encoded: string) {
  const raw = atob(encoded);
  let offset = 0;
  return {
    hasNext: () => offset < raw.length,
    next() {
      let value = 0, position = 1, byte: number;
      do {
        if (offset >= raw.length || position > 128 ** 7) throw new Error('보행망 타일을 읽을 수 없어요.');
        byte = raw.charCodeAt(offset++);
        value += (byte % 128) * position;
        position *= 128;
      } while (byte >= 128);
      return value % 2 ? -(value + 1) / 2 : value / 2;
    },
  };
}

function unpackSurface({ deltas, unitsPerMeter, ...grid }: SurfaceData): ShadeSurface {
  const values = decode(deltas);
  let height = 0;
  const elevation = new Float32Array(grid.width * grid.height);
  for (let i = 0; i < elevation.length; i++) {
    height += values.next();
    elevation[i] = height / unitsPerMeter;
  }
  if (values.hasNext()) throw new Error('서울 표면 높이 격자 크기가 일치하지 않아요.');
  return { ...grid, elevation };
}

function unpack(tile: Tile, west: number, south: number) {
  const originX = Math.round(west * 1e7), originY = Math.round(south * 1e7);
  let id = 0, x = originX, y = originY;
  const nodeData = decode(tile.n), wayData = decode(tile.w), profiles = decode(tile.b);
  const nodes: OsmElement[] = [], ways: OsmElement[] = [], buildings: ShadingBuilding[] = [];
  while (nodeData.hasNext()) {
    id += nodeData.next(); x += nodeData.next(); y += nodeData.next();
    nodes.push({ id, type: 'node', lon: x / 1e7, lat: y / 1e7, tags: tile.t[nodeData.next()] });
  }
  id = 0;
  while (wayData.hasNext()) {
    id += wayData.next();
    const tags = tile.t[wayData.next()];
    const count = wayData.next();
    let index = 0;
    const references = Array.from({ length: count }, () => {
      index += wayData.next();
      return nodes[index].id;
    });
    ways.push({ id, type: 'way', tags, nodes: references });
  }
  id = 0; x = originX; y = originY;
  while (profiles.hasNext()) {
    id += profiles.next();
    const heightM = profiles.next() / 100;
    const footprint = Array.from({ length: profiles.next() }, (): Coordinate => {
      x += profiles.next(); y += profiles.next();
      return [x / 1e7, y / 1e7];
    });
    buildings.push({ osmId: id, heightM, footprint });
  }
  return { nodes, ways, buildings };
}

async function read<T>(name: string, signal: AbortSignal, hash?: string): Promise<T> {
  const response = await fetch(directory + name, { signal });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('서울 보행망 자료를 불러오지 못했어요.');
  if (!hash) return response.json();
  const data = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', data);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) throw new Error('서울 보행망 자료의 출처를 확인하지 못했어요.');
  return JSON.parse(new TextDecoder().decode(data));
}

export async function fetchSeoulNetwork(start: Coordinate, end: Coordinate, signal: AbortSignal): Promise<Network | null> {
  const request = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  const index = await read<Index>('index.json', request);
  if (index.tileFormat !== 1) throw new Error('서울 보행망 파일 형식을 확인할 수 없어요.');
  const [south, west, north, east] = index.bbox;
  const coverage: Network['bounds'] = [[west, south], [east, north]];
  if (!coordinateInside(start, coverage) || !coordinateInside(end, coverage)) return null;
  const col = (lon: number) => Math.floor((lon - west) / index.step);
  const row = (lat: number) => Math.floor((lat - south) / index.step);
  const margin = 0.015;
  const x1 = col(Math.max(west, Math.min(start[0], end[0]) - margin));
  const x2 = col(Math.min(east, Math.max(start[0], end[0]) + margin));
  const y1 = row(Math.max(south, Math.min(start[1], end[1]) - margin));
  const y2 = row(Math.min(north, Math.max(start[1], end[1]) + margin));
  const bbox: SourceProvenance['bbox'] = [south + y1 * index.step, west + x1 * index.step,
    Math.min(north, south + (y2 + 1) * index.step), Math.min(east, west + (x2 + 1) * index.step)];
  const ids = [];
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) {
    if (Object.hasOwn(index.tiles, `${x}-${y}`)) ids.push(`${x}-${y}`);
  }
  if (!ids.length) return null;
  const [tiles, surfaces] = await Promise.all([
    Promise.all(ids.map(async id => [id, await read<Tile>(id + '.json', request, index.tiles[id])] as const)),
    read<SurfaceData[]>('surface.json', request, index.surfaceSha256),
  ]);
  request.throwIfAborted();
  const nodes = new Map<number, OsmElement>();
  const ways = new Map<number, OsmElement>();
  const buildings = new Map<string, ShadingBuilding[]>();
  for (const [id, tile] of tiles) {
    const unpacked = unpack(tile, west, south);
    for (const node of unpacked.nodes) nodes.set(node.id, node);
    for (const way of unpacked.ways) ways.set(way.id, way);
    buildings.set(id, unpacked.buildings);
  }
  const provenance: SourceProvenance = { ...index, bbox, sha256: index.tiles[ids[0]] };
  const network = buildNetwork({ elements: [...nodes.values(), ...ways.values()] }, provenance);
  const zones = new Map<string, NonNullable<Network['forecastZones']>[number]>();
  for (const segment of network.segments) {
    const [a, b] = segment.coordinates;
    const x = col((a[0] + b[0]) / 2), y = row((a[1] + b[1]) / 2);
    const id = `${x}-${y}`;
    let zone = zones.get(id);
    if (!zone) {
      const left = west + x * index.step, bottom = south + y * index.step;
      const right = Math.min(east, left + index.step), top = Math.min(north, bottom + index.step);
      zone = { center: [(left + right) / 2, (bottom + top) / 2], bounds: [[left, bottom], [right, top]],
        segments: [], buildings: buildings.get(id) ?? [] };
      zones.set(id, zone);
    }
    zone.segments.push(segment);
  }
  return { ...network, forecastZones: [...zones.values()], shadeSurfaces: surfaces.map(unpackSurface) };
}
