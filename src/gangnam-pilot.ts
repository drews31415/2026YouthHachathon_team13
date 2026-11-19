import type { ShadedSection } from './core/icing-forecast';
import type { Network } from './core/types';
import { hasHeatingWeather, type IcingHour } from './services/icing-weather';

export const gangnamDemoPlaces = { origin: 'node/12372983292', destination: 'node/9061817575' };
export const maljukgeoriFootbridge = {
  name: '말죽거리보도육교',
  osmWayId: '724658649',
  heatingLengthM: 140,
  heatingRecord: 868,
  heatingInstalled: '2024-11',
  // The source specifies a month, so apply the record only after that month.
  heatingEligibleFrom: Date.parse('2024-12-01T00:00:00+09:00'),
  heatingSource: 'https://data.seoul.go.kr/dataList/OA-22584/F/1/datasetView.do',
  facilitySource: 'https://data.seoul.go.kr/dataList/OA-15003/S/1/datasetView.do',
};

const installations = new Map([
  [maljukgeoriFootbridge.osmWayId, maljukgeoriFootbridge.heatingEligibleFrom],
  // Seoul heating inventory 870, Gangnam footbridge register, and OSM bridge:name agree.
  ['922445013', Date.parse('2024-12-01T00:00:00+09:00')],
]);

export function heatedWalkWarnings(network: Network, sections: readonly ShadedSection[], hour: IcingHour): ReadonlySet<string> {
  if (!hasHeatingWeather(hour)) return new Set();
  const bridgeSegments = new Set(network.segments.filter(segment => {
    const installed = installations.get(segment.wayId);
    return installed !== undefined && hour.time >= installed;
  }).map(segment => segment.id));
  return new Set(sections.filter(section => section.bridge && bridgeSegments.has(section.segmentId)).map(section => section.segmentId));
}
