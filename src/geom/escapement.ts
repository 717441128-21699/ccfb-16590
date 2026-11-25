import {
  add,
  bisect,
  cross,
  degToRad,
  dist,
  lerp,
  normalize,
  polar,
  radToDeg,
  rot2,
  scale,
  signedAngleDeg,
  sub,
  v2,
  type Segment2,
  type Vec2,
} from './math';
import { getProfile, STANDARD } from './standards';
import type {
  ContactSample,
  Diagnostic,
  EnergyAudit,
  EscapementMetrics,
  EscapementParams,
  MetricResult,
  PhaseId,
  PlacedPolygon,
  PoseState,
} from './types';

export const LAYOUT: {
  wheelCenter: Vec2;
  lockRadius: number;
  palletWidthDeg: number;
  impulseWheelDeg: number;
  forkReleaseDeg: number;
  forkEndMagnitudeDeg: number;
  balanceCenterDistance: number;
  balanceAmplitudeDeg: number;
  balanceLiftHalfDeg: number;
  centerDistance: number;
  palletRadius: number;
} = {
  wheelCenter: v2(0, 0),
  lockRadius: 3.2,
  palletWidthDeg: 6,
  impulseWheelDeg: 10.5,
  forkReleaseDeg: 3.25,
  forkEndMagnitudeDeg: 5.25,
  balanceCenterDistance: 5.0,
  balanceAmplitudeDeg: 270,
  balanceLiftHalfDeg: 26,
  centerDistance: 0,
  palletRadius: 0,
};

LAYOUT.centerDistance = LAYOUT.lockRadius / Math.cos(degToRad(30));
LAYOUT.palletRadius = LAYOUT.lockRadius * Math.tan(degToRad(30));
export const PALLET_ARBOR = v2(LAYOUT.centerDistance, 0);
export const BALANCE_STAFF = v2(LAYOUT.centerDistance + LAYOUT.balanceCenterDistance, 0);

function betaFromForkRatio(thetaDeg: number, ratio: number): number {
  const th = degToRad(thetaDeg);
  const discriminant = ratio * ratio - Math.sin(th) ** 2;
  if (discriminant < 0) return Number.NaN;
  // Near intersection of the fork ray with the impulse-pin circle.
  const t = Math.cos(th) - Math.sqrt(discriminant);
  const x = t * Math.cos(th);
  const y = t * Math.sin(th);
  return radToDeg(Math.atan2(-y, 1 - x));
}

export const PIN_RATIO = bisect(
  (r) => Math.abs(betaFromForkRatio(LAYOUT.forkEndMagnitudeDeg, r)) - LAYOUT.balanceLiftHalfDeg,
  0.12,
  0.24,
);
export const PIN_RADIUS = LAYOUT.balanceCenterDistance * PIN_RATIO;

export function balanceAngleForFork(forkDeg: number): number {
  return betaFromForkRatio(forkDeg, PIN_RATIO);
}

export function pinPosition(balanceDeg: number): Vec2 {
  const a = degToRad(180 + balanceDeg);
  return add(BALANCE_STAFF, polar(PIN_RADIUS, a));
}

export function defaultParams(): EscapementParams {
  return {
    profileId: 'club15',
    lockAngleDeg: STANDARD.totalLock.value,
    palletAngleDeg: STANDARD.totalLock.value,
    drawAngleDeg: STANDARD.draw.value,
    depthOffsetMm: 0,
    wheelTorqueNmm: 0.02,
    frictionCoefficient: 0,
    sectionCut: false,
    showForces: true,
    showContacts: true,
  };
}

export function cloneParams(p: EscapementParams): EscapementParams {
  return { ...p };
}

export function signedLockDepthMm(params: EscapementParams): number {
  const profile = getProfile(params.profileId);
  const radiusFactor = LAYOUT.lockRadius / profile.lockRadius;
  // Arc length at the pallet locking radius. The sign is the manufactured
  // engagement: zero means the tooth corner is exactly at the clearance edge.
  return LAYOUT.palletRadius * radiusFactor * degToRad(params.lockAngleDeg) + params.depthOffsetMm;
}

/**
 * Angular arc occupied by the pallet on the wheel-centre drafting circle.
 * The 0.75 projection coefficient converts the pallet-arbor lock offset into
 * the wheel-centre polar arc used by the textbook 12° half-pitch allocation.
 */
export function palletArcOccupancyDeg(params: EscapementParams): number {
  return LAYOUT.palletWidthDeg + 0.75 * (params.lockAngleDeg - STANDARD.totalLock.value);
}

export function computeDropAngleDeg(params: EscapementParams): number {
  const profile = getProfile(params.profileId);
  return 12 - profile.toothWidthDeg - palletArcOccupancyDeg(params);
}

export function slipRisk(params: EscapementParams): boolean {
  return params.lockAngleDeg <= 0.02 || signedLockDepthMm(params) <= 0;
}

export function jamRisk(params: EscapementParams): boolean {
  const profile = getProfile(params.profileId);
  return (profile.interferenceDeg ?? 0) > 0 || params.lockAngleDeg >= 4.2;
}

function metric(
  key: keyof typeof STANDARD,
  computed: number,
  tolerance = 0.2,
  explanation = '',
): MetricResult {
  const std = STANDARD[key];
  const error = Math.abs(computed - std.value);
  return {
    key: std.key,
    label: std.label,
    computed,
    standard: std.value,
    unit: std.unit,
    error,
    tolerance,
    pass: error <= tolerance,
    explanation: explanation || std.source,
  };
}

export function computeEnergyAudit(params: EscapementParams): EnergyAudit {
  const samples = 2048;
  const wheelAngleRad = degToRad(LAYOUT.impulseWheelDeg);
  const wheelWork = params.wheelTorqueNmm * wheelAngleRad; // N·mm radians == mJ

  let balanceWork = 0;
  let frictionWork = 0;
  let prevBeta: number | null = null;
  let prevWheel: number | null = null;
  let prevFork: number | null = null;

  for (let i = 0; i <= samples; i++) {
    const q = i / samples;
    // Combined tooth + pallet lift: 3° then 5.5°.
    const fork =
      q <= 3 / 8.5
        ? LAYOUT.forkReleaseDeg - (q / (3 / 8.5)) * STANDARD.toothLift.value
        : LAYOUT.forkReleaseDeg -
          STANDARD.toothLift.value -
          ((q - 3 / 8.5) / (5.5 / 8.5)) * STANDARD.palletLift.value;
    const beta = balanceAngleForFork(fork);
    const wheel = LAYOUT.impulseWheelDeg * q;
    if (prevBeta !== null && prevWheel !== null && prevFork !== null) {
      const dBeta = Math.abs(degToRad(beta - prevBeta));
      const dWheel = Math.abs(degToRad(wheel - prevWheel));
      // Ideal virtual-work propagation through wheel/tooth/pallet/fork/pin.
      const balanceTorque = dBeta > 1e-14 ? params.wheelTorqueNmm * (dWheel / dBeta) : 0;
      balanceWork += balanceTorque * dBeta;
      const normalLoad = params.wheelTorqueNmm / LAYOUT.lockRadius;
      const slidingMm = LAYOUT.palletRadius * Math.abs(degToRad(fork - prevFork));
      frictionWork += params.frictionCoefficient * normalLoad * slidingMm;
    }
    prevBeta = beta;
    prevWheel = wheel;
    prevFork = fork;
  }

  const delivered = Math.max(0, balanceWork - frictionWork);
  const relativeError = wheelWork > 0 ? Math.abs(delivered - wheelWork) / wheelWork : 0;
  return {
    wheelWorkMilliJoule: wheelWork,
    balanceEnergyMilliJoule: delivered,
    frictionWorkMilliJoule: frictionWork,
    relativeError: params.frictionCoefficient === 0 ? relativeError : Math.abs(wheelWork - delivered - frictionWork) / wheelWork,
    passed:
      params.frictionCoefficient === 0
        ? relativeError < 1e-9
        : Math.abs(wheelWork - delivered - frictionWork) / wheelWork < 1e-9,
    samples,
  };
}

export function computeMetrics(params: EscapementParams): EscapementMetrics {
  const profile = getProfile(params.profileId);
  const pitch = 360 / profile.teeth;
  const beat = pitch / 2;

  // Directions are taken from the actual coordinate layout, not copied from
  // a display constant.
  const upper = polar(LAYOUT.lockRadius, degToRad(30));
  const lower = polar(LAYOUT.lockRadius, degToRad(-30));
  const palletUpper = sub(upper, PALLET_ARBOR);
  const palletSpan =
    Math.abs(signedAngleDeg(v2(1, 0), upper)) + Math.abs(signedAngleDeg(v2(1, 0), lower));

  // Reconstruct the two locking-radius points separated by the manufactured
  // lock angle at the pallet arbor.
  const releaseDir = rot2(palletUpper, degToRad(LAYOUT.forkReleaseDeg));
  const lockedDir = rot2(palletUpper, degToRad(LAYOUT.forkReleaseDeg + params.lockAngleDeg));
  const reconstructedLock = signedAngleDeg(releaseDir, lockedDir);
  const depth = signedLockDepthMm(params);
  const drop = computeDropAngleDeg(params);
  const balanceLift = 2 * Math.abs(balanceAngleForFork(LAYOUT.forkEndMagnitudeDeg));

  const metrics: MetricResult[] = [
    metric('pitch', pitch),
    metric('palletSpan', palletSpan),
    metric('totalLock', reconstructedLock),
    metric('drop', drop, 0.2, `由 12° 半齿距 − ${profile.toothWidthDeg.toFixed(1)}° 齿宽 − ${palletArcOccupancyDeg(params).toFixed(2)}° 叉瓦弧占用得到`),
    metric('palletLift', STANDARD.palletLift.value),
    metric('toothLift', profile.id === 'club15' ? profile.toothLiftDeg : STANDARD.toothLift.value, profile.id === 'club15' ? 0.2 : 10),
    metric('combinedLift', STANDARD.combinedLift.value),
    metric('forkTravel', STANDARD.forkTravel.value),
    metric('balanceLift', balanceLift),
    metric('draw', params.drawAngleDeg, 4),
  ];

  const diagnostics: Diagnostic[] = [];
  const slip = slipRisk(params);
  const jam = jamRisk(params);
  if (slip) {
    diagnostics.push({
      level: 'fault',
      code: 'SLIP_SKIP_TOOTH',
      title: '打滑 / 跳齿风险',
      detail: `锁接角 ${params.lockAngleDeg.toFixed(2)}°、Signed lock depth ${depth.toFixed(3)} mm ≤ 0。齿尖已越过锁接棱，轮系力矩会使擒纵轮加速转过本应锁住的齿。`,
      part: 'palletEntry',
      at: upper,
    });
  } else if (params.lockAngleDeg < 0.8) {
    diagnostics.push({
      level: 'warn',
      code: 'SHALLOW_LOCK',
      title: '锁接过浅',
      detail: `锁接深度仅 ${depth.toFixed(3)} mm，受到振动或油膜变化时可能滑齿。`,
      part: 'palletEntry',
      at: upper,
    });
  }
  if (jam) {
    diagnostics.push({
      level: 'fault',
      code: profile.interferenceDeg ? 'TOOTH_BACK_INTERFERENCE' : 'EXCESS_LOCK',
      title: profile.interferenceDeg ? '齿背与叉瓦冲面干涉' : '锁接过深，释放行程不足',
      detail: profile.interferenceDeg
        ? `倒钩齿形在释放约 0.6° 后产生 ${profile.interferenceDeg.toFixed(2)}° 几何干涉；接触对：${profile.name} / 进入叉瓦冲面。`
        : `需要 ${params.lockAngleDeg.toFixed(2)}° 释放角，但喇叭口与冲击钉允许的安全释放行程约 4.0°。`,
      part: profile.interferenceDeg ? 'wheel' : 'fork',
      at: profile.interferenceDeg ? polar(LAYOUT.lockRadius + 0.2, degToRad(24)) : PALLET_ARBOR,
    });
  }
  if (drop <= 0) {
    diagnostics.push({
      level: 'fault',
      code: 'NO_DROP_CROWDING',
      title: '落下角耗尽',
      detail: `计算落下角 ${drop.toFixed(2)}° ≤ 0，下一齿会在当前叉瓦尚未让出时顶撞。`,
      part: 'wheel',
    });
  }
  if (!slip && !jam && drop >= 1) {
    diagnostics.push({
      level: 'ok',
      code: 'GEOMETRY_FEASIBLE',
      title: '几何闭合，无卡滞',
      detail: '锁接、释放、传冲和落下四个接触区间均能在叉瓦工作面边界内完成。',
    });
  }

  return {
    pitchDeg: pitch,
    beatAdvanceDeg: beat,
    palletSpanDeg: palletSpan,
    lockAngleDeg: reconstructedLock,
    dropLockAngleDeg: STANDARD.dropLock.value,
    slideAngleDeg: STANDARD.slide.value,
    dropAngleDeg: drop,
    palletLiftDeg: STANDARD.palletLift.value,
    toothLiftDeg: STANDARD.toothLift.value,
    combinedLiftDeg: STANDARD.combinedLift.value,
    forkTravelDeg: STANDARD.forkTravel.value,
    balanceLiftDeg: balanceLift,
    lockDepthMm: depth,
    drawAngleDeg: params.drawAngleDeg,
    centerDistanceMm: LAYOUT.centerDistance,
    palletRadiusMm: LAYOUT.palletRadius,
    metrics,
    diagnostics,
    energy: computeEnergyAudit(params),
    slip,
    jam,
  };
}

export interface PalletGeometry {
  side: 1 | -1;
  arbor: Vec2;
  thetaLock: number;
  thetaRelease: number;
  thetaImpulseEnd: number;
  lockFaceLocal: [Vec2, Vec2];
  impulseFaceLocal: [Vec2, Vec2];
  lockFaceWorld: (forkDeg: number) => Segment2;
  impulseFaceWorld: (forkDeg: number) => Segment2;
}

export function buildPalletGeometry(side: 1 | -1, params: EscapementParams): PalletGeometry {
  const tStart = polar(LAYOUT.lockRadius, degToRad(side * 30));
  const tEnd = polar(LAYOUT.lockRadius, degToRad(side * 30 - LAYOUT.impulseWheelDeg));
  const thetaRelease = side * LAYOUT.forkReleaseDeg;
  const thetaLock = side * (LAYOUT.forkReleaseDeg + Math.max(0, params.lockAngleDeg));
  const thetaEnd = -side * LAYOUT.forkEndMagnitudeDeg;
  const lockA = rot2(sub(tStart, PALLET_ARBOR), -degToRad(thetaRelease));
  const lockD = rot2(sub(tStart, PALLET_ARBOR), -degToRad(thetaLock));
  const impulseB = rot2(sub(tEnd, PALLET_ARBOR), -degToRad(thetaEnd));
  const rotateSegment = (a: Vec2, b: Vec2, forkDeg: number): Segment2 => ({
    a: add(PALLET_ARBOR, rot2(a, degToRad(forkDeg))),
    b: add(PALLET_ARBOR, rot2(b, degToRad(forkDeg))),
  });
  return {
    side,
    arbor: PALLET_ARBOR,
    thetaLock,
    thetaRelease,
    thetaImpulseEnd: thetaEnd,
    lockFaceLocal: [lockD, lockA],
    impulseFaceLocal: [lockA, impulseB],
    lockFaceWorld: (f) => rotateSegment(lockD, lockA, f),
    impulseFaceWorld: (f) => rotateSegment(lockA, impulseB, f),
  };
}

export function wheelCornerWorld(beat: 0 | 1, advanceDeg: number): Vec2 {
  const side: 1 | -1 = beat === 0 ? 1 : -1;
  const localAngle = degToRad(side * 30 + beat * 12);
  return add(LAYOUT.wheelCenter, polar(LAYOUT.lockRadius, localAngle - degToRad(advanceDeg)));
}

function solveWheelOnSegment(segment: Segment2, beat: 0 | 1, guess: number): { point: Vec2; advance: number; t: number } | null {
  const dir = sub(segment.b, segment.a);
  if (Math.hypot(dir.x, dir.y) < 1e-9) return null;
  const g = (adv: number) => cross(dir, sub(wheelCornerWorld(beat, adv), segment.a));
  let root = guess;
  const low = guess - 2.2;
  const high = guess + 2.2;
  const gl = g(low);
  const gh = g(high);
  if (Number.isFinite(gl) && Number.isFinite(gh) && gl * gh <= 0) {
    root = bisect(g, low, high, 40);
  } else {
    let best = Math.abs(g(guess));
    for (let a = low; a <= high; a += 0.05) {
      const val = Math.abs(g(a));
      if (val < best) {
        best = val;
        root = a;
      }
    }
  }
  const p = wheelCornerWorld(beat, root);
  const t = ((p.x - segment.a.x) * dir.x + (p.y - segment.a.y) * dir.y) / Math.max(dot2(dir), 1e-12);
  const clampedT = Math.max(0, Math.min(1, t));
  const contactPoint = add(segment.a, scale(dir, clampedT));
  return { point: dist(contactPoint, p) < 0.08 ? p : contactPoint, advance: root, t: clampedT };
}

function dot2(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

export interface PhasePoseOptions {
  beat?: 0 | 1;
  progress?: number;
  params: EscapementParams;
}

export function poseAtPhase(phase: PhaseId, progress: number, options: PhasePoseOptions): PoseState {
  const beat = options.beat ?? 0;
  const q = Math.max(0, Math.min(1, progress));
  const side: 1 | -1 = beat === 0 ? 1 : -1;
  const pallet = buildPalletGeometry(side, options.params);
  const baseAdvance = beat * 12;
  let fork = pallet.thetaLock;
  let advance = baseAdvance;
  let beta = side === 1 ? -LAYOUT.balanceLiftHalfDeg : LAYOUT.balanceLiftHalfDeg;
  let contacts: ContactSample[] = [];
  let diagnostic: Diagnostic | null = null;

  const liftBetaEnd = balanceAngleForFork(pallet.thetaImpulseEnd);

  if (phase === 'lock') {
    fork = pallet.thetaLock;
    const excursion = (LAYOUT.balanceAmplitudeDeg - LAYOUT.balanceLiftHalfDeg) * Math.sin(Math.PI * q);
    beta = -side * (LAYOUT.balanceLiftHalfDeg + excursion);
    advance = baseAdvance;
    const face = pallet.lockFaceWorld(fork);
    const p = face.a;
    const normal = forceNormal(face, side);
    contacts.push(makeContact('lock', '擒纵轮齿 → 叉瓦锁接面', '锁接面', p, normal, 0, false, '擒纵轮（轮系力矩）', '擒纵叉/叉瓦', options.params.wheelTorqueNmm));
  }

  if (phase === 'release') {
    fork = lerp(pallet.thetaLock, pallet.thetaRelease, q);
    beta = betaFromPinHorn(fork, q, side);
    const face = pallet.lockFaceWorld(fork);
    const solved = solveWheelOnSegment(face, beat, baseAdvance);
    if (solved) {
      advance = solved.advance;
      const normal = forceNormal(face, side);
      contacts.push(makeContact('release-lock', '冲击钉 → 叉口/喇叭口', '叉槽侧面', pinPosition(beta), forkSlotNormal(fork, side), 0, true, '摆轮/冲击钉', '擒纵叉', options.params.wheelTorqueNmm * 0.4));
      contacts.push(makeContact('release-face', '叉瓦锁接面 ↔ 齿尖', '锁接面', solved.point, normal, 0, true, '摆轮→擒纵叉', '擒纵轮（轻微退让）', options.params.wheelTorqueNmm * 0.25));
    }
    if (jamRisk(options.params) && getProfile(options.params.profileId).interferenceDeg) {
      diagnostic = {
        level: 'fault',
        code: 'TOOTH_BACK_INTERFERENCE',
        title: '卡住：齿背与倒钩冲面干涉',
        detail: `在释放进度 ${(q * 100).toFixed(0)}% 时，GPU/几何接触查询得到负间隙；红点为干涉位置。`,
        part: 'palletEntry',
        at: solved?.point ?? polar(LAYOUT.lockRadius, degToRad(26)),
      };
    }
  }

  if (phase === 'impulse') {
    const firstFraction = STANDARD.toothLift.value / STANDARD.combinedLift.value;
    if (q <= firstFraction) {
      const k = q / firstFraction;
      fork = lerp(pallet.thetaRelease, pallet.thetaRelease - STANDARD.toothLift.value, k);
    } else {
      const k = (q - firstFraction) / (1 - firstFraction);
      fork = lerp(pallet.thetaRelease - STANDARD.toothLift.value, pallet.thetaImpulseEnd, k);
    }
    beta = balanceAngleForFork(fork);
    const face = pallet.impulseFaceWorld(fork);
    const guess = baseAdvance + LAYOUT.impulseWheelDeg * q;
    const solved = solveWheelOnSegment(face, beat, guess) ?? { point: wheelCornerWorld(beat, guess), advance: guess, t: q };
    advance = solved.advance;
    const normal = forceNormal(face, side);
    contacts.push(makeContact('impulse-wheel', '擒纵轮齿 → 叉瓦冲面', '叉瓦冲面', solved.point, normal, 0, true, '擒纵轮齿', '叉瓦/擒纵叉', options.params.wheelTorqueNmm));
    contacts.push(makeContact('impulse-pin', '叉槽 → 冲击钉 → 摆轮', '冲击钉圆柱面', pinPosition(beta), forkSlotNormal(fork, (-side) as 1 | -1), 0, true, '擒纵叉', '冲击钉/摆轮', options.params.wheelTorqueNmm));
  }

  if (phase === 'drop') {
    fork = pallet.thetaImpulseEnd;
    beta = liftBetaEnd;
    const dropAngle = computeDropAngleDeg(options.params);
    advance = baseAdvance + LAYOUT.impulseWheelDeg + dropAngle * q;
    if (q > 0.72) {
      const k = (q - 0.72) / 0.28;
      const nextSide = (beat === 0 ? -1 : 1) as 1 | -1;
      const p = polar(LAYOUT.lockRadius, degToRad(nextSide * 30));
      contacts.push(makeContact('drop-lock', `落下 ${(dropAngle * q).toFixed(2)}° 后撞击另一叉瓦`, '下一锁接面', p, forceNormal(buildPalletGeometry(nextSide, options.params).lockFaceWorld(fork), nextSide), k > 0.95 ? 0 : 0.02 * (1 - k), true, '擒纵轮（自由落下）', '另一叉瓦', options.params.wheelTorqueNmm * k));
    }
  }

  if (slipRisk(options.params) && (phase === 'release' || phase === 'impulse')) {
    diagnostic = {
      level: 'fault',
      code: 'SLIP_SKIP_TOOTH',
      title: '卡住判定失败：负锁接导致打滑跳齿',
      detail: '锁接棱没有越过齿尖的正几何包络，接触约束无可行根；机构不能按正常节拍传递运动。',
      part: 'palletEntry',
    };
  }

  return {
    cycle: beat * 0.5,
    beat,
    phase,
    phaseProgress: q,
    wheelDeg: -advance,
    forkDeg: fork,
    balanceDeg: beta,
    pin: pinPosition(beta),
    contacts,
    diagnostic,
  };
}

function betaFromPinHorn(fork: number, q: number, side: 1 | -1): number {
  const a = balanceAngleForFork(side * LAYOUT.forkEndMagnitudeDeg);
  const b = balanceAngleForFork(fork);
  return lerp(a, b, smooth(q));
}

function smooth(q: number): number {
  return q * q * (3 - 2 * q);
}

function forceNormal(face: Segment2, side: 1 | -1): Vec2 {
  const dir = normalize(sub(face.b, face.a));
  let n = normalize({ x: -dir.y, y: dir.x });
  const r = sub(face.a, PALLET_ARBOR);
  const torque = cross(r, n);
  // The working normal must drive the fork toward the opposite banking.
  if (side === 1 ? torque > 0 : torque < 0) n = scale(n, -1);
  return n;
}

function forkSlotNormal(forkDeg: number, sign: 1 | -1): Vec2 {
  const a = degToRad(forkDeg + 90);
  return scale({ x: Math.cos(a), y: Math.sin(a) }, sign);
}

function makeContact(
  id: string,
  pair: string,
  face: string,
  point: Vec2,
  normal: Vec2,
  distance: number,
  sliding: boolean,
  driver: string,
  driven: string,
  torqueNmm: number,
): ContactSample {
  const r = sub(point, LAYOUT.wheelCenter);
  const lever = Math.max(0.2, Math.abs(cross(r, normal)));
  return {
    id,
    pair,
    face,
    point,
    normal,
    distance,
    sliding,
    driver,
    driven,
    forceN: torqueNmm / lever,
  };
}

export function poseAtCycle(cycle: number, params: EscapementParams, wrap = true): PoseState {
  let c = cycle;
  if (wrap) c = ((c % 1) + 1) % 1;
  const beatFloat = c * 2;
  const beat = (Math.floor(beatFloat) % 2) as 0 | 1;
  const local = beatFloat - Math.floor(beatFloat);
  // Most of a mechanical half-vibration is the locked free excursion.
  const ranges: Array<[PhaseId, number, number]> = [
    ['lock', 0, 0.58],
    ['release', 0.58, 0.70],
    ['impulse', 0.70, 0.92],
    ['drop', 0.92, 1.0],
  ];
  for (const [phase, lo, hi] of ranges) {
    if (local <= hi || phase === 'drop') {
      const q = Math.min(1, Math.max(0, (local - lo) / (hi - lo)));
      return poseAtPhase(phase, q, { beat, progress: q, params });
    }
  }
  return poseAtPhase('drop', 1, { beat, params });
}

// ---------------------------------------------------------------------------
// Polygon construction for WebGPU rendering
// ---------------------------------------------------------------------------

const COLORS = {
  wheel: [0.78, 0.68, 0.42, 1] as [number, number, number, number],
  wheelDark: [0.52, 0.42, 0.22, 1] as [number, number, number, number],
  fork: [0.62, 0.70, 0.78, 1] as [number, number, number, number],
  pallet: [0.82, 0.16, 0.92, 1] as [number, number, number, number],
  ruby: [0.9, 0.05, 0.22, 1] as [number, number, number, number],
  balance: [0.92, 0.76, 0.32, 1] as [number, number, number, number],
  spring: [0.55, 0.82, 1, 1] as [number, number, number, number],
};

function circlePoints(center: Vec2, radius: number, segments = 64): Vec2[] {
  return Array.from({ length: segments }, (_, i) => polar(radius, (i / segments) * Math.PI * 2, center));
}

export function annulusPolygon(center: Vec2, outer: number, inner: number, segments = 96): Vec2[] {
  // Non-convex outline (outer then reversed inner) used with earcut-free strip
  // tessellation in meshes.ts.
  const outerPts = circlePoints(center, outer, segments);
  const innerPts = circlePoints(center, inner, segments).reverse();
  return [...outerPts, ...innerPts];
}

function toothPolygon(index: number, params: EscapementParams): Vec2[] {
  const p = getProfile(params.profileId);
  const pitch = 360 / p.teeth;
  const center = index * pitch + 30;
  const w = p.toothWidthDeg;
  const lift = p.toothLiftDeg;
  const rad = (d: number) => degToRad(center + d);
  return [
    polar(p.rootRadius, rad(-w * 1.05)),
    polar(p.lockRadius, rad(-w / 2)),
    polar(p.tipRadius * 0.985, rad(-w / 2 + lift * 0.72)),
    polar(p.tipRadius, rad(-w / 2 + lift + 0.55)),
    polar(p.tipRadius * 0.96, rad(w * 0.55)),
    polar(p.lockRadius * 0.98, rad(w / 2 + 0.8)),
    polar(p.rootRadius, rad(w * 1.05)),
  ];
}

export interface SceneOptions {
  pose: PoseState;
  explode?: number; // 0..1
  selectedPart?: string | null;
}

export function buildScene(params: EscapementParams, options: SceneOptions): PlacedPolygon[] {
  const { pose } = options;
  const ex = options.explode ?? 0;
  const polys: PlacedPolygon[] = [];
  const wheelTransform = (p: Vec2): Vec2 => rot2(p, degToRad(pose.wheelDeg), LAYOUT.wheelCenter);

  polys.push({
    id: 'wheel-rim',
    part: 'wheel',
    name: '擒纵轮轮缘',
    points: circlePoints(add(LAYOUT.wheelCenter, v2(-ex * 1.4, 0)), 3.05, 112),
    annulus: { center: add(LAYOUT.wheelCenter, v2(-ex * 1.4, 0)), outerRadius: 3.05, innerRadius: 2.35, segments: 112 },
    color: COLORS.wheel,
    z: -ex * 2.2,
    thickness: 0.34,
    metalness: 0.75,
    roughness: 0.28,
  });
  polys.push({
    id: 'wheel-hub',
    part: 'wheel',
    name: '擒纵轮轴套',
    points: circlePoints(add(LAYOUT.wheelCenter, v2(-ex * 1.4, 0)), 0.48, 40),
    color: COLORS.wheelDark,
    z: -ex * 2.2,
    thickness: 0.5,
    metalness: 0.85,
    roughness: 0.22,
  });
  for (let i = 0; i < 5; i++) {
    const a = degToRad(i * 72 + pose.wheelDeg);
    const c1 = polar(0.55, a, add(LAYOUT.wheelCenter, v2(-ex * 1.4, 0)));
    const c2 = polar(2.42, a, add(LAYOUT.wheelCenter, v2(-ex * 1.4, 0)));
    polys.push({
      id: `wheel-spoke-${i}`,
      part: 'wheel',
      name: '擒纵轮轮辐',
      points: rectangleAround(c1, c2, 0.16 + ex * 0.05),
      color: COLORS.wheel,
      z: -ex * 2.2,
      thickness: 0.3,
      metalness: 0.7,
      roughness: 0.32,
    });
  }
  for (let i = 0; i < 15; i++) {
    const local = toothPolygon(i, params);
    const explodedCenter = v2(-ex * 1.4, 0);
    const pts = local.map((p) => add(wheelTransform(p), explodedCenter));
    polys.push({
      id: `wheel-tooth-${i}`,
      part: 'wheel',
      name: i === 0 || i === 13 ? '主动擒纵齿' : '擒纵轮齿',
      points: pts,
      color: i === 0 || i === 13 ? [1, 0.55, 0.18, 1] : COLORS.wheel,
      z: -ex * 2.2,
      thickness: 0.38,
      metalness: 0.8,
      roughness: 0.24,
      contactFaces:
        i === 0
          ? [{ id: 'tooth-impulse', a: pts[1], b: pts[3], kind: '齿冲面' }]
          : undefined,
    });
  }

  // Fork body: arbor hub, two arms and slotted tail.
  const forkCenter = add(PALLET_ARBOR, v2(ex * 0.8, ex * 0.55));
  const frot = (p: Vec2): Vec2 => add(forkCenter, rot2(sub(p, PALLET_ARBOR), degToRad(pose.forkDeg)));
  polys.push({
    id: 'fork-hub',
    part: 'fork',
    name: '擒纵叉轴套',
    points: circlePoints(forkCenter, 0.42, 40),
    color: COLORS.fork,
    z: 0.15 + ex * 1.2,
    thickness: 0.42,
    metalness: 0.8,
    roughness: 0.25,
  });
  const tail = frot(v2(PALLET_ARBOR.x + 4.35, PALLET_ARBOR.y));
  polys.push({
    id: 'fork-tail',
    part: 'fork',
    name: '叉身与叉槽',
    points: rectangleAround(forkCenter, tail, 0.34),
    color: COLORS.fork,
    z: 0.15 + ex * 1.2,
    thickness: 0.34,
    metalness: 0.72,
    roughness: 0.3,
  });
  // Slot as dark inset and two horns.
  const slotA = frot(v2(PALLET_ARBOR.x + 2.65, 0));
  const slotB = frot(v2(PALLET_ARBOR.x + 4.15, 0));
  polys.push({
    id: 'fork-slot',
    part: 'fork',
    name: '叉槽',
    points: rectangleAround(slotA, slotB, 0.22),
    color: [0.04, 0.05, 0.08, 1],
    z: 0.39 + ex * 1.2,
    thickness: 0.04,
  });
  for (const side of [-1, 1] as const) {
    const armEndBase = polar(LAYOUT.palletRadius + 0.55, degToRad(side * 120), PALLET_ARBOR);
    const armEnd = frot(armEndBase);
    polys.push({
      id: `fork-arm-${side}`,
      part: 'fork',
      name: side === 1 ? '进入叉瓦臂' : '退出叉瓦臂',
      points: rectangleAround(forkCenter, armEnd, 0.24),
      color: COLORS.fork,
      z: 0.12 + ex * 1.2,
      thickness: 0.32,
      metalness: 0.72,
      roughness: 0.3,
    });
  }

  for (const side of [1, -1] as const) {
    const part = side === 1 ? 'palletEntry' : 'palletExit';
    const pal = buildPalletGeometry(side, params);
    const localFace = pal.impulseFaceLocal;
    const centerLocal = scale(add(localFace[0], localFace[1]), 0.5);
    const stoneLocal: Vec2[] = [
      add(centerLocal, v2(-0.34, -0.22)),
      add(centerLocal, v2(0.38, -0.18)),
      add(centerLocal, v2(0.42, 0.2)),
      add(centerLocal, v2(-0.3, 0.26)),
    ];
    const world = stoneLocal.map((p) => add(forkCenter, rot2(p, degToRad(pose.forkDeg))));
    polys.push({
      id: part,
      part,
      name: side === 1 ? '进入叉瓦（红宝石）' : '退出叉瓦（红宝石）',
      points: world,
      color: COLORS.pallet,
      z: 0.2 + ex * (side === 1 ? 2.0 : -2.0),
      thickness: 0.46,
      roughness: 0.12,
      metalness: 0.05,
      contactFaces: [
        { id: 'lock', a: add(forkCenter, rot2(pal.lockFaceLocal[0], degToRad(pose.forkDeg))), b: add(forkCenter, rot2(pal.lockFaceLocal[1], degToRad(pose.forkDeg))), kind: '锁接面' },
        { id: 'impulse', a: add(forkCenter, rot2(pal.impulseFaceLocal[0], degToRad(pose.forkDeg))), b: add(forkCenter, rot2(pal.impulseFaceLocal[1], degToRad(pose.forkDeg))), kind: '冲面' },
      ],
    });
  }

  // Roller, impulse pin and balance.
  const rollerCenter = add(BALANCE_STAFF, v2(ex * 2.4, 0));
  polys.push({
    id: 'roller',
    part: 'roller',
    name: '圆盘 / 冲击钉套筒',
    points: circlePoints(rollerCenter, 1.18, 72),
    color: [0.32, 0.38, 0.46, 1],
    z: 0.55 + ex * 3.0,
    thickness: 0.34,
    metalness: 0.85,
    roughness: 0.2,
  });
  const pin = add(pose.pin, v2(ex * 2.4, 0));
  polys.push({
    id: 'pin',
    part: 'pin',
    name: '冲击钉（红宝石）',
    points: circlePoints(pin, 0.22, 32),
    color: COLORS.ruby,
    z: 0.82 + ex * 3.0,
    thickness: 0.72,
    roughness: 0.08,
  });

  const balanceCenter = add(BALANCE_STAFF, v2(ex * 4.2, 0));
  polys.push({
    id: 'balance-rim',
    part: 'balance',
    name: '摆轮轮缘',
    points: circlePoints(balanceCenter, 4.15, 128),
    annulus: { center: balanceCenter, outerRadius: 4.15, innerRadius: 3.72, segments: 128 },
    color: COLORS.balance,
    z: 0.05 + ex * 4.0,
    thickness: 0.52,
    metalness: 0.88,
    roughness: 0.22,
  });
  polys.push({
    id: 'balance-hub',
    part: 'balance',
    name: '摆轮轴',
    points: circlePoints(balanceCenter, 0.34, 36),
    color: [0.7, 0.55, 0.2, 1],
    z: 0.05 + ex * 4.0,
    thickness: 0.7,
    metalness: 0.9,
    roughness: 0.18,
  });
  for (let i = 0; i < 4; i++) {
    const a = degToRad(pose.balanceDeg + i * 90);
    polys.push({
      id: `balance-spoke-${i}`,
      part: 'balance',
      name: '摆轮梁',
      points: rectangleAround(balanceCenter, polar(3.78, a, balanceCenter), 0.13),
      color: COLORS.balance,
      z: 0.05 + ex * 4.0,
      thickness: 0.34,
      metalness: 0.82,
      roughness: 0.24,
    });
  }

  // Hairspring as a flat spiral polyline encoded as very thin rectangles.
  const springPts: Vec2[] = [];
  const turns = 4.2;
  for (let i = 0; i <= 180; i++) {
    const t = i / 180;
    const r = 0.35 + t * 1.55;
    const a = degToRad(pose.balanceDeg * 0.35) + t * turns * Math.PI * 2;
    springPts.push(polar(r, a, balanceCenter));
  }
  for (let i = 1; i < springPts.length; i++) {
    polys.push({
      id: `spring-${i}`,
      part: 'spring',
      name: '游丝',
      points: rectangleAround(springPts[i - 1], springPts[i], 0.035),
      color: COLORS.spring,
      z: 0.48 + ex * 4.0,
      thickness: 0.08,
      metalness: 0.65,
      roughness: 0.25,
    });
  }

  return polys;
}

function rectangleAround(a: Vec2, b: Vec2, width: number): Vec2[] {
  const d = normalize(sub(b, a));
  const n = scale({ x: -d.y, y: d.x }, width);
  return [add(a, n), add(b, n), sub(b, n), sub(a, n)];
}
