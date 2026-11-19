import { addOsmSubwayEntrances, buildNetwork } from '../core/network';
import entranceSource from '../subway-entrances.json';
import type { Network, SourceProvenance } from '../core/types';

/** Only the acquired public snapshot is loaded; there is no fallback graph. */
export async function fetchNetwork(signal?: AbortSignal): Promise<Network> {
  const timeout = AbortSignal.timeout(20_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const [roads, source] = await Promise.all([fetch('/data/osm.json', { signal: requestSignal }), fetch('/data/provenance.json', { signal: requestSignal })]);
  if (!roads.ok || !source.ok) throw new Error('실제 보행망 자료를 불러오지 못했습니다. 다시 불러와 주세요.');
  if (![roads, source].every(response => response.headers.get('content-type')?.includes('application/json'))) throw new Error('서버에 실제 보행망 파일이 없습니다. 자료를 복구한 뒤 다시 불러와 주세요.');
  const raw = await roads.text();
  const provenance: SourceProvenance = await source.json();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== provenance.sha256) throw new Error('보행망 원본과 출처 기록이 일치하지 않아 사용을 중단했습니다.');
  const network = buildNetwork(JSON.parse(raw), provenance);
  if (!network.segments.length) throw new Error('사용 가능한 실제 보행 구간이 없습니다.');
  return addOsmSubwayEntrances(network, entranceSource);
}
