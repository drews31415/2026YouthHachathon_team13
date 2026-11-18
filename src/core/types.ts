export type Coordinate = [number, number]; // GeoJSON [longitude, latitude]
export type Scenario = 'freezing' | 'dry' | 'missing' | 'stale' | 'blocked';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export interface Place { id: string; name: string; category: string; coordinate: Coordinate; nodeId: string; }
export interface WalkNode { id: string; coordinate: Coordinate; }
export interface WalkSegment {
  id: string; from: string; to: string; name: string; coordinates: Coordinate[];
  lengthM: number; slope: number | null; stairs: boolean | null;
  shade: number | null; moisture: number | null;
  source: string;
}
export interface Network { nodes: WalkNode[]; segments: WalkSegment[]; places: Place[]; bounds: [Coordinate, Coordinate]; source: string; }
export interface RiskEstimate {
  segmentId: string; level: RiskLevel; score: number | null; reasons: string[];
  dataStatus: 'complete' | 'missing' | 'stale';
}
export interface ModelRun {
  id: string; method: 'rule-based-simulation'; version: string;
  analyzedAt: string; validUntil: string; scenario: Scenario;
  temperatureC: number | null; precipitationMm: number | null;
  estimates: RiskEstimate[];
}
export interface RouteStep { segmentId: string; name: string; distanceM: number; durationSeconds: number; instruction: string; coordinate: Coordinate; }
export interface Route {
  id: string; type: 'normal' | 'recommended'; distanceM: number; durationSeconds: number;
  coordinates: Coordinate[]; segmentIds: string[]; steps: RouteStep[];
  highRiskCount: number; unknownCount: number;
}
export interface SearchOptions {
  originId: string; destinationId: string; walkingSpeedMps: number;
  avoidStairs: boolean; maxSlopePercent: number | null; scenario: Scenario;
}
export type SearchStatus = 'ok' | 'invalid-input' | 'out-of-area' | 'insufficient-data' | 'stale-data' | 'no-route' | 'no-recommendation';
export interface SearchResult {
  status: SearchStatus; message: string; run: ModelRun;
  normal: Route | null; recommended: Route | null; extraSeconds: number | null;
}
