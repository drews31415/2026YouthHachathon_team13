import type { SearchResult } from './types';

/** Expiration invalidates routes as well as the displayed segment risks. */
export function expireResult(result: SearchResult, now = Date.now()): SearchResult {
  if (result.status === 'stale-data' || now < Date.parse(result.run.validUntil)) return result;
  return {
    ...result, status: 'stale-data',
    message: '위험 정보의 유효시간이 지났어요. 경로 찾기를 눌러 새 자료로 다시 계산해 주세요.',
    normal: null, recommended: null, extraSeconds: null,
    run: { ...result.run, estimates: result.run.estimates.map(risk => ({
      ...risk, level: 'unknown', score: null, dataStatus: 'stale',
      reasons: ['자료의 유효시간이 지났습니다. 다시 조회해 주세요.'],
    })) },
  };
}
