import { addOsmSubwayEntrances, buildNetwork } from '../core/network';
import entranceSource from '../subway-entrances.json';
import type { Network, ShadeSurface, ShadingBuilding, SourceProvenance } from '../core/types';
import type { IcingArea } from './icing-weather';

/** Only the acquired public snapshot is loaded; there is no fallback graph. */
export async function fetchNetwork(signal?: AbortSignal, area: IcingArea = 'gwanak'): Promise<Network> {
  const timeout = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const directory = area === 'gangnam' ? '/data/gangnam/' : '/data/';
  const files = area === 'gangnam' ? ['osm.json', 'provenance.json', 'buildings.json', 'surface.json'] : ['osm.json', 'provenance.json'];
  const [roads, source, buildingsFile, surfaceFile] = await Promise.all(files.map(file => fetch(directory + file, { signal: requestSignal })));
  if (![roads, source, buildingsFile, surfaceFile].filter(Boolean).every(response => response.ok && response.headers.get('content-type')?.includes('application/json'))) {
    throw new Error('보행망 또는 그늘 자료를 불러오지 못했습니다. 다시 불러와 주세요.');
  }
  const raw = await roads.text();
  const provenance: SourceProvenance = await source.json();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== provenance.sha256) throw new Error('보행망 원본과 출처 기록이 일치하지 않아 사용을 중단했습니다.');
  const network = buildNetwork(JSON.parse(raw), provenance);
  if (!network.segments.length) throw new Error('사용 가능한 실제 보행 구간이 없습니다.');
  if (area === 'gangnam') {
    const buildings: { sourceSha256: string; buildings: ShadingBuilding[] } = await buildingsFile.json();
    const grid: ShadeSurface = await surfaceFile.json();
    if (buildings.sourceSha256 !== provenance.sourceFileSha256 || !buildings.buildings?.length ||
        !Number.isFinite(grid.lon) || !Number.isFinite(grid.lat) || !(grid.stepLon > 0) || !(grid.stepLat > 0) ||
        !Number.isInteger(grid.width) || !Number.isInteger(grid.height) ||
        grid.elevation?.length !== grid.width * grid.height) throw new Error('보행망과 그늘 자료의 출처를 확인하지 못했습니다.');
    return { ...network, expandedShadingBuildings: buildings.buildings, shadeSurface: grid };
  }
  return addOsmSubwayEntrances(network, entranceSource);
}
