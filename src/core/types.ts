export type Coordinate = [number, number]; // GeoJSON [longitude, latitude]
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export interface SourceProvenance {
  source: string; endpoint: string; downloadedAt: string; osmTimestamp: string;
  license: string; licenseUrl: string; sha256: string;
  bbox: [number, number, number, number]; // south, west, north, east
  query?: string; limitations?: string[];
}
export interface Place {
  id: string; name: string; category: string;
  coordinate: Coordinate; // actual OSM feature / user-selected coordinate
  nodeId: string; routeCoordinate: Coordinate;
  snapDistanceM: number; // straight-line gap, NOT a verified walking connection
  sourceId: string; sourceType: 'node' | 'way' | 'coordinate'; sourceUrl: string | null;
  aliases?: string[]; // only verbatim alternate names recorded in the source
}
export interface WalkNode { id: string; coordinate: Coordinate; tags: Record<string, string>; }
export interface WalkSegment {
  id: string; from: string; to: string; name: string; coordinates: Coordinate[];
  lengthM: number; slope: number | null; stairs: boolean | null;
  source: string; wayId: string; tags: Record<string, string>;
  direction: 'both' | 'forward' | 'backward';
}
export interface Network {
  nodes: WalkNode[]; segments: WalkSegment[]; places: Place[];
  bounds: [Coordinate, Coordinate]; source: string; provenance: SourceProvenance;
  exclusions: { inaccessibleWays: number; blockedNodes: number; blockedSegments: number; outsideOrMissingSegments: number; unsnappedPlaces: number };
}
export interface RiskEstimate {
  segmentId: string; level: RiskLevel; score: number | null; reasons: string[];
  dataStatus: 'complete' | 'missing' | 'stale';
}
export interface ModelRun {
  id: string; method: 'no-icing-observations'; version: string;
  analyzedAt: string; validUntil: string | null;
  temperatureC: null; precipitationMm: null;
  estimates: RiskEstimate[];
}
export interface RouteStep { segmentId: string; name: string; distanceM: number; durationSeconds: number; instruction: string; coordinate: Coordinate; }
export interface Route {
  id: string; type: 'normal' | 'recommended'; distanceM: number; durationSeconds: number;
  coordinates: Coordinate[]; segmentIds: string[]; steps: RouteStep[];
  highRiskCount: number; unknownCount: number;
}
export interface SearchOptions {
  origin: Place | null; destination: Place | null; walkingSpeedMps: number;
  avoidStairs: boolean; maxSlopePercent: number | null;
}
export type SearchStatus = 'ok' | 'invalid-input' | 'out-of-area' | 'insufficient-data' | 'stale-data' | 'no-route' | 'no-recommendation';
export interface SearchResult {
  status: SearchStatus; message: string; run: ModelRun;
  normal: Route | null; recommended: Route | null; extraSeconds: number | null;
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation'; id: number;
  lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string>;
}
export interface OsmPayload {
  elements: OsmElement[]; osm3s?: { timestamp_osm_base?: string }; remark?: string;
}
