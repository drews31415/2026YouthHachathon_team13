import type { Coordinate, Network, OsmElement, ShadingBuilding, ShadeSurface } from './types';
import additionalBuildings from '../icing-buildings.json';
import surface from '../icing-surface.json';

export function buildingsWithHeight(nodes: ReadonlyMap<number, OsmElement>, ways: Iterable<OsmElement>): ShadingBuilding[] {
  const buildings: ShadingBuilding[] = [];
  for (const way of ways) {
    if (!way.tags?.building || way.tags.building === 'no' || !way.nodes || way.nodes.length < 4 || way.nodes[0] !== way.nodes.at(-1)) continue;
    const height = /^(\d+(?:\.\d+)?)(?: ?m)?$/.exec(way.tags.height?.trim() ?? '');
    const heightM = Number(height?.[1]);
    if (!(heightM > 0)) continue;
    const vertices = way.nodes.slice(0, -1).map(id => nodes.get(id));
    if (vertices.some(node => !Number.isFinite(node?.lon) || !Number.isFinite(node?.lat))) continue;
    buildings.push({ osmId: way.id, heightM, footprint: vertices.map(node => [node!.lon!, node!.lat!]) });
  }
  return buildings;
}

const radians = (degrees: number) => degrees * Math.PI / 180;
const metersPerDegree = Math.PI * 6_371_008.8 / 180;
const minSolarElevation = radians(8);
const sampleSpacingM = 5;

// NOAA's fractional year, equation of time and solar declination. Return the
// sun vector in local east, north and up components for a UTC instant.
export function sunPosition(timeMs: number, [lon, lat]: Coordinate) {
  const date = new Date(timeMs);
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const days = (Date.UTC(year + 1, 0, 1) - start) / 86_400_000;
  const angle = 2 * Math.PI * ((timeMs - start) / 86_400_000 - .5) / days;
  const eqTime = 229.18 * (.000075 + .001868 * Math.cos(angle) - .032077 * Math.sin(angle)
    - .014615 * Math.cos(2 * angle) - .040849 * Math.sin(2 * angle));
  const declination = .006918 - .399912 * Math.cos(angle) + .070257 * Math.sin(angle)
    - .006758 * Math.cos(2 * angle) + .000907 * Math.sin(2 * angle)
    - .002697 * Math.cos(3 * angle) + .00148 * Math.sin(3 * angle);
  const hourAngle = radians((date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60 + eqTime + 4 * lon) / 4 - 180);
  const latitude = radians(lat);
  return {
    east: -Math.cos(declination) * Math.sin(hourAngle),
    north: Math.cos(latitude) * Math.sin(declination) - Math.sin(latitude) * Math.cos(declination) * Math.cos(hourAngle),
    up: Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
  };
}

function contains([x, y]: Coordinate, polygon: Coordinate[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface ShadedSection { segmentId: string; coordinates: [Coordinate, Coordinate]; buildingId: number | null; bridge?: boolean; }
export interface ShadeEstimate { sunTooLow: boolean; sections: ShadedSection[]; }

export function liveShadingBuildings(network: Pick<Network, 'shadingBuildings' | 'expandedShadingBuildings' | 'provenance'>): ShadingBuilding[] {
  if (network.expandedShadingBuildings) return network.expandedShadingBuildings;
  if (network.provenance.sourceFileSha256 !== additionalBuildings.sourceSha256) return network.shadingBuildings ?? [];
  return additionalBuildings.buildings.map(building => ({
    osmId: building.osmId, heightM: building.heightM,
    footprint: building.footprint.map(([lon, lat]): Coordinate => [lon, lat]),
  }));
}

export const surfaceShadeSource = { url: surface.licenseUrl, attribution: surface.attribution };
const surfaceHeight = (grid: ShadeSurface, column: number, row: number) =>
  column >= 0 && column < grid.width && row >= 0 && row < grid.height
    ? grid.elevation[row * grid.width + column] : undefined;

// The DSM includes vegetation and structures. Ignore the first 150 m of
// cells so nearby buildings use their separately registered OSM profiles.
function shadedBySurface(grids: ShadeSurface[], [lon, lat]: Coordinate, sun: ReturnType<typeof sunPosition>, lonScale: number) {
  const grid = grids.find(grid => {
    const col = Math.round((lon - grid.lon) / grid.stepLon), row = Math.round((grid.lat - lat) / grid.stepLat);
    return col >= 0 && col < grid.width && row >= 0 && row < grid.height;
  });
  if (!grid) return false;
  const originX = (lon - grid.lon) / grid.stepLon, originY = (grid.lat - lat) / grid.stepLat;
  const column = Math.round(originX), row = Math.round(originY);
  const start = surfaceHeight(grid, column, row);
  if (start === undefined) return false;
  let base = start;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    base = Math.min(base, surfaceHeight(grid, column + dx, row + dy) ?? base);
  }
  const horizontal = Math.hypot(sun.east, sun.north);
  if (horizontal < 1e-4) return false;
  const rise = sun.up / horizontal;
  const eastPerM = sun.east / horizontal / (lonScale * grid.stepLon);
  const northPerM = sun.north / horizontal / (metersPerDegree * grid.stepLat);
  for (let distance = 150; distance <= 2500; distance += 20) {
    const col = Math.round(originX + distance * eastPerM), r = Math.round(originY - distance * northPerM);
    const pointLon = grid.lon + col * grid.stepLon, pointLat = grid.lat - r * grid.stepLat;
    let elevation = surfaceHeight(grid, col, r);
    if (elevation === undefined) {
      for (const other of grids) {
        if (other === grid) continue;
        elevation = surfaceHeight(other, Math.round((pointLon - other.lon) / other.stepLon), Math.round((other.lat - pointLat) / other.stepLat));
        if (elevation !== undefined) break;
      }
    }
    if (elevation !== undefined && elevation > base + distance * rise + 3) return true;
  }
  return false;
}

/** Project registered building profiles onto locally flat ground. */
export function estimateBuildingShade(network: Pick<Network, 'bounds' | 'segments' | 'shadingBuildings' | 'expandedShadingBuildings' | 'shadeSurface' | 'shadeSurfaces' | 'provenance'>, timeMs: number, expanded = false): ShadeEstimate {
  const [[west, south], [east, north]] = network.bounds;
  const center: Coordinate = [(west + east) / 2, (south + north) / 2];
  const sun = sunPosition(timeMs, center);
  const sunTooLow = !(sun.up >= Math.sin(minSolarElevation));
  if (sunTooLow && !expanded) return { sunTooLow, sections: [] };

  const lonScale = metersPerDegree * Math.cos(radians(center[1]));
  const project = ([lon, lat]: Coordinate): Coordinate => [(lon - center[0]) * lonScale, (lat - center[1]) * metersPerDegree];
  const buildings = sunTooLow ? [] : expanded ? liveShadingBuildings(network) : network.shadingBuildings ?? [];
  const grids = network.shadeSurfaces ?? [network.shadeSurface ?? surface];
  const shadows = buildings.map(building => {
    const footprint = building.footprint.map(project);
    const moved = footprint.map(([x, y]): Coordinate => [x - building.heightM * sun.east / sun.up, y - building.heightM * sun.north / sun.up]);
    const sides = footprint.map((point, index) => {
      const next = (index + 1) % footprint.length;
      return [point, footprint[next], moved[next], moved[index]];
    });
    const all = [...footprint, ...moved];
    return { id: building.osmId, footprint, sides,
      minX: Math.min(...all.map(p => p[0])), maxX: Math.max(...all.map(p => p[0])),
      minY: Math.min(...all.map(p => p[1])), maxY: Math.max(...all.map(p => p[1])) };
  });

  const sections: ShadedSection[] = [];
  for (const segment of network.segments) {
    const { highway, indoor, covered, tunnel, bridge, location } = segment.tags;
    if (!['footway', 'pedestrian', 'path', 'steps'].includes(highway) || covered === 'yes' ||
        (indoor && indoor !== 'no') || (tunnel && tunnel !== 'no') ||
        location === 'underground') continue;
    const [start, end] = segment.coordinates;
    if (bridge && bridge !== 'no') {
      if (expanded) sections.push({ segmentId: segment.id, coordinates: [start, end], buildingId: null, bridge: true });
      continue;
    }
    if (sunTooLow) continue;
    const [px, py] = project(start), [qx, qy] = project(end);
    const nearby = shadows.filter(s => s.minX <= Math.max(px, qx) && s.maxX >= Math.min(px, qx)
      && s.minY <= Math.max(py, qy) && s.maxY >= Math.min(py, qy));
    if (!nearby.length && !expanded) continue;
    const samples = Math.ceil(segment.lengthM / sampleSpacingM);
    const along = (fraction: number): Coordinate => [
      start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction,
    ];
    let previous: ShadedSection | undefined;
    for (let index = 0; index < samples; index++) {
      const coordinate = along((index + .5) / samples);
      const point = project(coordinate);
      // Footprints alone can overlap entrance paths. Use the projected outdoor shadow.
      const building = nearby.find(shadow => point[0] >= shadow.minX && point[0] <= shadow.maxX
        && point[1] >= shadow.minY && point[1] <= shadow.maxY
        && !contains(point, shadow.footprint) && shadow.sides.some(side => contains(point, side)));
      if (!building && !(expanded && shadedBySurface(grids, coordinate, sun, lonScale))) { previous = undefined; continue; }
      const buildingId = building?.id ?? null;
      const finish = along((index + 1) / samples);
      if (previous && previous.buildingId === buildingId) previous.coordinates[1] = finish;
      else {
        previous = { segmentId: segment.id, buildingId, coordinates: [along(index / samples), finish] };
        sections.push(previous);
      }
    }
  }
  return { sunTooLow, sections };
}
