import { describe, expect, it, vi } from 'vitest';
import { analyzeRisk, findPlaces, nearestPlace, network, scoreRiskFeatures, searchRoutes } from './engine';
import { distanceBetween, geometryLength } from './network';
import type { SearchOptions } from './types';

const defaults: SearchOptions = {
  originId: 'snu-station', destinationId: 'gwanak-office', walkingSpeedMps: 1,
  avoidStairs: true, maxSlopePercent: null, scenario: 'freezing',
};

describe('risk baseline and evidence states', () => {
  it('uses preceding precipitation and residual moisture independently, without interpreting missing values as zero', () => {
    const inputs = { temperatureC: -3, precipitationMm: 0, moisture: 0.9, shade: 0.8 };
    const noRecentRain = scoreRiskFeatures(inputs)!;
    const recentRain = scoreRiskFeatures({ ...inputs, precipitationMm: 3 })!;
    expect(recentRain).toBeGreaterThan(noRecentRain);
    expect(noRecentRain).toBeGreaterThan(0.7); // Residual water can matter without new rain.
    expect(scoreRiskFeatures({ ...inputs, precipitationMm: null })).toBeNull();
    expect(scoreRiskFeatures({ ...inputs, temperatureC: NaN })).toBeNull();
    expect(scoreRiskFeatures({ ...inputs, moisture: -1 })).toBeNull();
  });
  it('marks the two wet shaded shortcuts high without treating slope as ice evidence', () => {
    const run = analyzeRisk('freezing');
    expect(run.method).toBe('rule-based-simulation');
    expect(run.estimates.filter(estimate => estimate.level === 'high').map(estimate => estimate.segmentId))
      .toEqual(expect.arrayContaining(['n12-n22', 'n22-n31']));
    const stairs = network.segments.find(segment => segment.stairs)!;
    expect(run.estimates.find(estimate => estimate.segmentId === stairs.id)?.level).not.toBe('high');
  });
  it('never classifies a segment with missing environment inputs as low', () => {
    for (const scenario of ['freezing', 'dry'] as const) {
      const estimate = analyzeRisk(scenario).estimates.find(risk => risk.segmentId === 'n00-n10');
      expect(estimate).toMatchObject({ level: 'unknown', score: null, dataStatus: 'missing' });
    }
  });
  it.each(['missing', 'stale'] as const)('does not invent routes or a delay for %s data', scenario => {
    const result = searchRoutes({ ...defaults, scenario });
    expect(result.status).toBe(scenario === 'missing' ? 'insufficient-data' : 'stale-data');
    expect(result.normal).toBeNull();
    expect(result.recommended).toBeNull();
    expect(result.extraSeconds).toBeNull();
    expect(result.run.estimates.every(risk => risk.level === 'unknown' && risk.score === null)).toBe(true);
  });
  it('makes stale analysis and validity visibly in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T09:00:00Z'));
    const run = analyzeRisk('stale');
    expect(Date.parse(run.validUntil)).toBeLessThan(Date.now());
    expect(Date.parse(run.analyzedAt)).toBeLessThan(Date.parse(run.validUntil));
    vi.useRealTimers();
  });
});

describe('route calculation', () => {
  it('really excludes high and unknown edges and computes the extra duration from geometry', () => {
    const result = searchRoutes(defaults);
    expect(result.status).toBe('ok');
    expect(result.normal!.highRiskCount).toBe(2);
    expect(result.recommended!.highRiskCount).toBe(0);
    expect(result.recommended!.unknownCount).toBe(0);
    expect(result.recommended!.segmentIds).not.toContain('n12-n22');
    expect(result.recommended!.segmentIds).not.toContain('n22-n31');
    expect(result.extraSeconds).toBeGreaterThan(0);
    expect(result.extraSeconds).toBe(result.recommended!.durationSeconds - result.normal!.durationSeconds);
    for (const route of [result.normal!, result.recommended!]) {
      expect(route.distanceM).toBeCloseTo(geometryLength(route.coordinates), 8);
      expect(route.durationSeconds).toBeCloseTo(route.distanceM / defaults.walkingSpeedMps, 8);
      expect(route.steps.reduce((sum, step) => sum + step.durationSeconds, 0)).toBeCloseTo(route.durationSeconds, 8);
    }
  });
  it('reverses every edge geometry and keeps route endpoints and distance correct', () => {
    const forward = searchRoutes(defaults);
    const reverse = searchRoutes({ ...defaults, originId: defaults.destinationId, destinationId: defaults.originId });
    expect(reverse.status).toBe('ok');
    expect(reverse.normal!.coordinates).toEqual([...forward.normal!.coordinates].reverse());
    expect(reverse.recommended!.coordinates).toEqual([...forward.recommended!.coordinates].reverse());
    expect(reverse.normal!.distanceM).toBeCloseTo(forward.normal!.distanceM, 8);
    expect(reverse.normal!.steps[0].coordinate).toEqual(network.places.find(place => place.id === defaults.destinationId)!.coordinate);
  });
  it('uses the same speed on both routes and recalculates when speed changes', () => {
    const normalSpeed = searchRoutes(defaults);
    const halfSpeed = searchRoutes({ ...defaults, walkingSpeedMps: 0.5 });
    expect(halfSpeed.normal!.segmentIds).toEqual(normalSpeed.normal!.segmentIds);
    expect(halfSpeed.recommended!.durationSeconds).toBeCloseTo(normalSpeed.recommended!.durationSeconds * 2, 8);
    expect(halfSpeed.normal!.durationSeconds).toBeCloseTo(normalSpeed.normal!.durationSeconds * 2, 8);
    expect(halfSpeed.extraSeconds!).toBeCloseTo(normalSpeed.extraSeconds! * 2, 8);
  });
  it('returns an identical route and zero additional seconds for the dry fixture', () => {
    const result = searchRoutes({ ...defaults, scenario: 'dry' });
    expect(result.status).toBe('ok');
    expect(result.recommended!.segmentIds).toEqual(result.normal!.segmentIds);
    expect(result.extraSeconds).toBe(0);
  });
  it('preserves ordinary route only when no risk-aware recommendation is possible', () => {
    const result = searchRoutes({ ...defaults, scenario: 'blocked' });
    expect(result.status).toBe('no-recommendation');
    expect(result.normal).not.toBeNull();
    expect(result.normal!.highRiskCount).toBeGreaterThan(0);
    expect(result.recommended).toBeNull();
    expect(result.extraSeconds).toBeNull();
  });
  it('applies identical accessibility rules to both routes and excludes unknown metadata', () => {
    const result = searchRoutes({ ...defaults, maxSlopePercent: 5 });
    expect(result.status).toBe('ok');
    for (const route of [result.normal!, result.recommended!]) {
      for (const id of route.segmentIds) {
        const segment = network.segments.find(segment => segment.id === id)!;
        expect(segment.stairs).toBe(false);
        expect(segment.slope).not.toBeNull();
        expect(Math.abs(segment.slope!)).toBeLessThanOrEqual(5);
      }
    }
  });
  it('distinguishes an impossible accessibility path from risk data failure', () => {
    const result = searchRoutes({ ...defaults, maxSlopePercent: 0 });
    expect(result.status).toBe('no-route');
    expect(result.normal).toBeNull();
    expect(result.extraSeconds).toBeNull();
  });
  it('returns contiguous routes between all distinct registered places', () => {
    for (const origin of network.places) for (const destination of network.places) {
      if (origin.id === destination.id) continue;
      const result = searchRoutes({ ...defaults, originId: origin.id, destinationId: destination.id });
      expect(result.status).toBe('ok');
      for (const route of [result.normal!, result.recommended!]) {
        expect(route.coordinates[0]).toEqual(origin.coordinate);
        expect(route.coordinates.at(-1)).toEqual(destination.coordinate);
        expect(route.segmentIds.length).toBe(route.steps.length);
        expect(route.distanceM).toBeCloseTo(geometryLength(route.coordinates), 7);
        expect(new Set(route.segmentIds).size).toBe(route.segmentIds.length);
      }
      expect(result.extraSeconds!).toBeGreaterThanOrEqual(-0.000001);
    }
  });
});

describe('input and service area', () => {
  it.each([0, -1, NaN, Infinity, 2.1])('rejects invalid walking speed %s', walkingSpeedMps => {
    expect(searchRoutes({ ...defaults, walkingSpeedMps }).status).toBe('invalid-input');
  });
  it('rejects same origin/destination and unknown places instead of picking a default', () => {
    expect(searchRoutes({ ...defaults, destinationId: defaults.originId }).status).toBe('invalid-input');
    expect(searchRoutes({ ...defaults, originId: '' }).status).toBe('invalid-input');
    expect(searchRoutes({ ...defaults, originId: 'busan' }).status).toBe('out-of-area');
  });
  it('searches only actual registered names and preserves empty-query suggestions', () => {
    expect(findPlaces('서울 대입구')).toHaveLength(1);
    expect(findPlaces('서울 대입구')[0].id).toBe('snu-station');
    expect(findPlaces('부산')).toEqual([]);
    expect(findPlaces('')).toHaveLength(network.places.length);
  });
  it('does not snap out-of-area or invalid coordinates into the demo network', () => {
    expect(nearestPlace([129.0756, 35.1796])).toBeNull();
    expect(nearestPlace([NaN, 37.48])).toBeNull();
    expect(nearestPlace(network.places[0].coordinate)?.id).toBe('snu-station');
  });
  it('computes geodesic distances in meters', () => {
    expect(distanceBetween([0, 0], [0, 0])).toBe(0);
    expect(distanceBetween([0, 0], [0, 1])).toBeCloseTo(111195.08, 1);
  });
});
