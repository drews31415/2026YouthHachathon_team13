import { expect, it } from 'vitest';
import { searchRoutes } from './engine';
import { expireResult } from './resultLifecycle';
it('removes old routes, delay, and risk labels when their validity expires', () => {
  const result = searchRoutes({ originId: 'snu-station', destinationId: 'gwanak-office', walkingSpeedMps: 1, scenario: 'freezing', avoidStairs: true, maxSlopePercent: null });
  expect(expireResult(result, Date.parse(result.run.validUntil) - 1)).toBe(result);
  const expired = expireResult(result, Date.parse(result.run.validUntil));
  expect(expired.status).toBe('stale-data');
  expect(expired.normal).toBeNull();
  expect(expired.recommended).toBeNull();
  expect(expired.extraSeconds).toBeNull();
  expect(expired.run.estimates.every(item => item.level === 'unknown' && item.dataStatus === 'stale')).toBe(true);
  expect(expireResult(expired, Date.parse(result.run.validUntil) + 1000)).toBe(expired);
});
