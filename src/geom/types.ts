import type { Vec2 } from './math';

export type ToothProfileId = 'club15' | 'fine15' | 'broad15' | 'hook15';
export type PageId = 'demo' | 'phases' | 'explode' | 'params';
export type PhaseId = 'lock' | 'release' | 'impulse' | 'drop';
export type PartId = 'wheel' | 'fork' | 'palletEntry' | 'palletExit' | 'pin' | 'roller' | 'balance' | 'spring';

export interface ToothProfile {
  id: ToothProfileId;
  name: string;
  description: string;
  teeth: number;
  /** Angular thickness at the locking-circle radius, degrees. */
  toothWidthDeg: number;
  /** Angular length assigned to the tooth impulse plane, degrees. */
  toothLiftDeg: number;
  /** Back draft / rake angle, degrees. */
  draftDeg: number;
  tipRadius: number;
  lockRadius: number;
  rootRadius: number;
  /** Deliberate profile fault used by the jam classroom sample. */
  interferenceDeg?: number;
}

export interface EscapementParams {
  profileId: ToothProfileId;
  /** Total geometric lock angle at the pallet arbor, degrees. Standard 2.0. */
  lockAngleDeg: number;
  /** Extra pallet-stone setting rotation about its mounting normal, degrees. */
  palletAngleDeg: number;
  /** Locking-face draft/draw angle, degrees. Standard 12. */
  drawAngleDeg: number;
  /** Optional manufactured depth offset, mm. Positive cuts deeper. */
  depthOffsetMm: number;
  wheelTorqueNmm: number;
  frictionCoefficient: number;
  sectionCut: boolean;
  showForces: boolean;
  showContacts: boolean;
}

export interface StandardDatum {
  key: string;
  label: string;
  value: number;
  unit: string;
  source: string;
}

export interface MetricResult {
  key: string;
  label: string;
  computed: number;
  standard: number;
  unit: string;
  error: number;
  tolerance: number;
  pass: boolean;
  explanation: string;
}

export interface ContactSample {
  id: string;
  pair: string;
  face: string;
  point: Vec2;
  normal: Vec2;
  distance: number;
  sliding: boolean;
  driver: string;
  driven: string;
  forceN: number;
}

export interface Diagnostic {
  level: 'ok' | 'warn' | 'fault';
  code: string;
  title: string;
  detail: string;
  part?: PartId;
  at?: Vec2;
}

export interface EnergyAudit {
  wheelWorkMilliJoule: number;
  balanceEnergyMilliJoule: number;
  frictionWorkMilliJoule: number;
  relativeError: number;
  passed: boolean;
  samples: number;
}

export interface EscapementMetrics {
  pitchDeg: number;
  beatAdvanceDeg: number;
  palletSpanDeg: number;
  lockAngleDeg: number;
  dropLockAngleDeg: number;
  slideAngleDeg: number;
  dropAngleDeg: number;
  palletLiftDeg: number;
  toothLiftDeg: number;
  combinedLiftDeg: number;
  forkTravelDeg: number;
  balanceLiftDeg: number;
  lockDepthMm: number;
  drawAngleDeg: number;
  centerDistanceMm: number;
  palletRadiusMm: number;
  metrics: MetricResult[];
  diagnostics: Diagnostic[];
  energy: EnergyAudit;
  slip: boolean;
  jam: boolean;
}

export interface PoseState {
  cycle: number;
  beat: 0 | 1;
  phase: PhaseId;
  phaseProgress: number;
  wheelDeg: number;
  forkDeg: number;
  balanceDeg: number;
  pin: Vec2;
  contacts: ContactSample[];
  diagnostic: Diagnostic | null;
}

export interface PlacedPolygon {
  id: PartId | string;
  name: string;
  part: PartId;
  points: Vec2[];
  color: [number, number, number, number];
  metalness?: number;
  roughness?: number;
  z?: number;
  thickness?: number;
  annulus?: { center: Vec2; innerRadius: number; outerRadius: number; segments: number };
  contactFaces?: Array<{ id: string; a: Vec2; b: Vec2; kind: string }>;
}
