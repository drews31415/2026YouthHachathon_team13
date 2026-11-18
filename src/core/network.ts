import type { Coordinate, Network, WalkNode, WalkSegment } from './types';

/**
 * This is a deliberately small synthetic fixture, not a surveyed footway network.
 * Coordinates are in the Gwanak / Seoul National University Station area, but
 * connectivity, road labels, shade, moisture, slope and stairs are demo inputs.
 * Never use these segments as proof of public access or real-world walkability.
 */
export const NETWORK_SOURCE = '관악구 생활권 합성 시연 네트워크 · 현장 검증 전';

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => degrees * Math.PI / 180;

export function distanceBetween(a: Coordinate, b: Coordinate): number {
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function geometryLength(coordinates: Coordinate[]): number {
  return coordinates.slice(1).reduce((sum, coordinate, index) =>
    sum + distanceBetween(coordinates[index], coordinate), 0);
}

const longitude = [126.9494, 126.9515, 126.9528, 126.9545];
const latitude = [37.4822, 37.4811, 37.4797, 37.4783, 37.4770];
const nodes: WalkNode[] = latitude.flatMap((lat, row) => longitude.map((lng, column) => ({
  id: `n${row}${column}`,
  coordinate: [lng, lat] as Coordinate,
})));
const byId = new Map(nodes.map(node => [node.id, node]));

function segment(from: string, to: string, name: string, attributes: Partial<WalkSegment> = {}): WalkSegment {
  const coordinates: Coordinate[] = [byId.get(from)!.coordinate, byId.get(to)!.coordinate];
  return {
    id: `${from}-${to}`, from, to, name, coordinates,
    lengthM: geometryLength(coordinates), slope: 2, stairs: false,
    shade: 0.15, moisture: 0.12, source: NETWORK_SOURCE,
    ...attributes,
  };
}

const horizontalNames = ['봉천사거리 주변', '역 앞 보행로', '생활권 연결길', '구청 앞 보행로', '구청 남측 연결길'];
const verticalNames = ['서측 생활로', '관악로 서측 보행로', '중앙 연결길', '샤로수길 연결로'];
const segments: WalkSegment[] = [];
for (let row = 0; row < 5; row++) {
  for (let column = 0; column < 3; column++) {
    segments.push(segment(`n${row}${column}`, `n${row}${column + 1}`, horizontalNames[row], {
      slope: row === 4 ? 4.2 : 1.4,
    }));
  }
}
for (let row = 0; row < 4; row++) {
  for (let column = 0; column < 4; column++) {
    const attributes: Partial<WalkSegment> = { slope: column === 0 ? 3.5 : 2.2 };
    if (row === 1 && column === 2) {
      Object.assign(attributes, { name: '그늘진 연결길', shade: 0.95, moisture: 0.9 });
    }
    if (row === 2 && column === 3) {
      Object.assign(attributes, { name: '동측 계단길', stairs: true, slope: 12, shade: 0.3 });
    }
    if (row === 0 && column === 0) {
      Object.assign(attributes, { name: '환경정보 미확인 구간', stairs: null, slope: null, shade: null, moisture: null });
    }
    segments.push(segment(`n${row}${column}`, `n${row + 1}${column}`, verticalNames[column], attributes));
  }
}
segments.push(segment('n22', 'n31', '구청 방향 골목길', {
  shade: 0.85, moisture: 0.86, slope: 4.5,
}));

export const network: Network = {
  nodes,
  segments,
  places: [
    { id: 'snu-station', name: '서울대입구역', category: '지하철역 · 시연 지점', coordinate: byId.get('n12')!.coordinate, nodeId: 'n12' },
    { id: 'gwanak-office', name: '관악구청', category: '공공시설 · 시연 지점', coordinate: byId.get('n31')!.coordinate, nodeId: 'n31' },
    { id: 'sharosu', name: '샤로수길 입구', category: '생활권 · 시연 지점', coordinate: byId.get('n23')!.coordinate, nodeId: 'n23' },
    { id: 'bongcheon-crossing', name: '봉천사거리', category: '교차로 · 시연 지점', coordinate: byId.get('n02')!.coordinate, nodeId: 'n02' },
    { id: 'cheongryong', name: '청룡동 생활권', category: '주거지 · 시연 지점', coordinate: byId.get('n40')!.coordinate, nodeId: 'n40' },
    { id: 'office-south', name: '관악구청 남측', category: '생활권 · 시연 지점', coordinate: byId.get('n41')!.coordinate, nodeId: 'n41' },
  ],
  bounds: [[126.9487, 37.4765], [126.9552, 37.4828]],
  source: NETWORK_SOURCE,
};
