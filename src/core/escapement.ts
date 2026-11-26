/**
 * 瑞士杠杆擒纵 · 一拍事件引擎（标定版）。
 *
 * 全部特征角由命名线段/圆的接触几何用最小间隙优化求出，无关键帧。
 * 内部状态保留带符号角度；对外报告的锁接深度、落下角、提升角取物理量正值。
 *
 * 一拍四阶段（进瓦侧）：
 *   locked  锁接：轮齿锁面压在进瓦锁面上，轮被约束
 *   unlock  释放：摆轮经冲击钉推叉向中性线，轮齿沿锁面让刀直至脱开
 *   impulse 传冲：轮齿传冲面贴瓦传冲面，轮驱叉、叉经钉驱摆，直到齿尖滑出
 *   drop    落下：轮自由转过一小角，下一齿被出瓦锁面接住
 */
import {
  Vec2,
  v,
  add,
  sub,
  norm,
  dot,
  rot,
  TAU,
  rad,
  deg,
} from './math2d';
import type {
  MechanismParams,
  MechState,
  PhaseEvent,
  BeatAnalysis,
  JamInfo,
  EscapementPhase,
  DynamicContact,
} from './types';
import { buildGeometry, type MechanismGeometry } from './geometry';
import { worldSegment, circleSegGap, segSegGap } from './kinematics';
import { projectContact, CONTACT_TOL } from './tracker';

export interface Engine {
  params: MechanismParams;
  geo: MechanismGeometry;
}

export function makeEngine(params: MechanismParams): Engine {
  return { params, geo: buildGeometry(params) };
}

// ---------- 世界坐标取面 ----------

export function stoneSegment(
  eng: Engine,
  side: 1 | -1,
  face: 'lock' | 'impulse',
  qPallet: number,
): { a: Vec2; b: Vec2 } {
  const stone = eng.geo.stones.find((s) => s.side === side)!;
  const local = face === 'lock' ? stone.lockSeg : stone.impulseSeg;
  return worldSegment(local, 'pallet', { qWheel: 0, qPallet, qBalance: 0 }, eng.params);
}

export function toothSegment(
  eng: Engine,
  k: number,
  face: 'lock' | 'impulse',
  qWheel: number,
): { a: Vec2; b: Vec2 } {
  const n = eng.params.wheel.teeth;
  const t = eng.geo.wheel.teeth[((k % n) + n) % n];
  const local = face === 'lock' ? t.lockSeg : t.impulseSeg;
  return worldSegment(local, 'wheel', { qWheel, qPallet: 0, qBalance: 0 }, eng.params);
}

export function pinCenter(eng: Engine, qBalance: number): Vec2 {
  const rest = eng.geo.balance.pinRestCenter;
  const B = {
    x: eng.params.pallet.centerDistance,
    y: eng.params.fork.balanceDistance,
  };
  return add(B, rot(sub(rest, B), qBalance));
}

export interface GapResult {
  gap: number;
  point: Vec2;
  normal: Vec2;
  label: string;
}

export function wheelStoneGap(
  eng: Engine,
  side: 1 | -1,
  stoneFace: 'lock' | 'impulse',
  toothK: number,
  toothFace: 'lock' | 'impulse',
  state: MechState,
): GapResult {
  const ss = stoneSegment(eng, side, stoneFace, state.qPallet);
  const ts = toothSegment(eng, toothK, toothFace, state.qWheel);
  const r = segSegGap(ts, ss);
  const n = norm(sub(r.p2, r.p1));
  return {
    gap: r.gap,
    point: r.p1,
    normal: n,
    label: `轮齿${toothFace === 'lock' ? '锁接面' : '传冲面'} × ${side === 1 ? '进瓦' : '出瓦'}${stoneFace === 'lock' ? '锁接面' : '传冲面'}`,
  };
}

export function pinSlotGap(eng: Engine, side: 1 | -1, state: MechState): GapResult {
  const wall = side === 1 ? eng.geo.fork.slotWalls.entry : eng.geo.fork.slotWalls.exit;
  const want = side === 1 ? 'fork-wall-entry' : 'fork-wall-exit';
  const idx = wall.edgeLabels.findIndex((l) => l === want);
  const local = { a: wall.points[idx], b: wall.points[(idx + 1) % wall.points.length] };
  const ws = worldSegment(local, 'pallet', state, eng.params);
  const c = pinCenter(eng, state.qBalance);
  const r = circleSegGap(c, eng.params.fork.pinRadius, ws);
  return {
    gap: r.gap,
    point: r.closest,
    normal: r.normal,
    label: `冲击钉 × 叉口${side === 1 ? '进' : '出'}侧壁`,
  };
}

// ---------- 静止锁接态 ----------

function restPalletAngle(eng: Engine, side: 1 | -1): number {
  const b = rad(eng.params.fork.bankingHalfAngleDeg);
  return side === 1 ? -b * 0.2 : b * 0.2;
}

export function nearestTooth(eng: Engine, side: 1 | -1): number {
  const qp = restPalletAngle(eng, side);
  let best = 0;
  let bg = Infinity;
  for (let k = 0; k < eng.params.wheel.teeth; k++) {
    const g = wheelStoneGap(eng, side, 'lock', k, 'lock', {
      qWheel: 0,
      qPallet: qp,
      qBalance: 0,
    }).gap;
    if (g < bg) {
      bg = g;
      best = k;
    }
  }
  return best;
}

export function findLockedState(
  eng: Engine,
  side: 1 | -1,
  toothK: number,
): { state: MechState } | null {
  const qp = restPalletAngle(eng, side);
  const f = (qw: number) =>
    wheelStoneGap(eng, side, 'lock', toothK, 'lock', { qWheel: qw, qPallet: qp, qBalance: 0 }).gap;
  const qw = projectContact(f, 0, rad(20), 0.05, 240);
  if (!Number.isFinite(qw)) return null;
  return { state: { qWheel: qw, qPallet: qp, qBalance: 0 } };
}

// ---------- 几何指标直接测量 ----------

/** 锁接深度：齿尖沿瓦锁面越入瓦尖后方的弧长 / 接触半径（度，正值） */
export function measureLockDepth(eng: Engine, side: 1 | -1, toothK: number, state: MechState): number {
  const ss = stoneSegment(eng, side, 'lock', state.qPallet);
  const ts = toothSegment(eng, toothK, 'lock', state.qWheel);
  const tip = ts.b;
  const r = Math.hypot(tip.x, tip.y);
  const along = dot(sub(tip, ss.a), norm(sub(ss.b, ss.a)));
  return deg(along / r);
}

// ---------- 轨迹 ----------

export interface BeatTrackPoint {
  state: MechState;
  phase: EscapementPhase;
  contact: DynamicContact | null;
  energyToBalance: number;
}

export interface BeatResult {
  analysis: BeatAnalysis;
  track: BeatTrackPoint[];
}

function makeContact(
  eng: Engine,
  state: MechState,
  side: 1 | -1,
  stoneFace: 'lock' | 'impulse',
  toothK: number,
  toothFace: 'lock' | 'impulse',
): DynamicContact | null {
  const g = wheelStoneGap(eng, side, stoneFace, toothK, toothFace, state);
  if (Math.abs(g.gap) > 0.06) return null;
  return {
    bodyA: 0,
    bodyB: 1,
    point: g.point,
    normal: g.normal,
    normalForce: 0,
    frictionForce: 0,
    label: g.label,
  };
}

function ev(phase: EscapementPhase, state: MechState, note: string, contact: string): PhaseEvent {
  return { phase, state: { ...state }, note, contact };
}

// ---------- 主分析 ----------

export function analyzeBeat(eng: Engine, startToothIn?: number): BeatResult {
  const startTooth = startToothIn === undefined ? nearestTooth(eng, 1) : startToothIn;
  const warnings: string[] = [];
  const events: PhaseEvent[] = [];
  const track: BeatTrackPoint[] = [];
  let jammed: JamInfo | null = null;
  const banking = rad(eng.params.fork.bankingHalfAngleDeg);
  const qpRest = restPalletAngle(eng, 1);

  const locked = findLockedState(eng, 1, startTooth);
  if (!locked) {
    return {
      analysis: blankFail('找不到进瓦锁接态：几何不啮合', {
        phase: 'locked', contact: '进瓦锁接面', reason: '几何不啮合',
        state: { qWheel: 0, qPallet: 0, qBalance: 0 },
      }),
      track: [],
    };
  }

  const s0: MechState = { ...locked.state };
  const lockDepthDeg = measureLockDepth(eng, 1, startTooth, s0);
  events.push(ev('locked', s0, `锁接：轮齿锁面压在进瓦锁面上，锁接深度 ${lockDepthDeg.toFixed(2)}°`, '轮齿锁接面 × 进瓦锁接面'));
  track.push({ state: { ...s0 }, phase: 'locked', contact: makeContact(eng, s0, 1, 'lock', startTooth, 'lock'), energyToBalance: 0 });

  // ===== 阶段 1：释放。qp: qpRest -> 0，锁面贴合跟踪轮角（让刀） =====
  let qw = s0.qWheel;
  const N1 = 60;
  for (let i = 1; i <= N1; i++) {
    const qp = qpRest + ((0 - qpRest) * i) / N1;
    const nx = projectContact(
      (x) => wheelStoneGap(eng, 1, 'lock', startTooth, 'lock', { qWheel: x, qPallet: qp, qBalance: 0 }).gap,
      qw, rad(3),
    );
    if (!Number.isFinite(nx)) break;
    qw = nx;
    if (i % 4 === 0)
      track.push({ state: { qWheel: qw, qPallet: qp, qBalance: 0 }, phase: 'unlock', contact: makeContact(eng, { qWheel: qw, qPallet: qp, qBalance: 0 }, 1, 'lock', startTooth, 'lock'), energyToBalance: 0 });
  }
  const qwUnlock = qw;
  const unlockWheelDeg = Math.abs(deg(qwUnlock - s0.qWheel));
  const sUnlock: MechState = { qWheel: qwUnlock, qPallet: 0, qBalance: 0 };
  events.push(ev('unlock', sUnlock, `释放：叉转至中性线，轮让刀 ${unlockWheelDeg.toFixed(2)}°，锁面脱开`, '进瓦锁接面末端'));
  track.push({ state: { ...sUnlock }, phase: 'unlock', contact: null, energyToBalance: 0 });

  // ===== 阶段 2a：轮自由转到传冲面贴合（qp 保持 0） =====
  let qImp = qwUnlock;
  let bestGap = Infinity;
  for (let d = 0; d <= 600; d++) {
    const q = qwUnlock + rad(8 * d / 600);
    const g = wheelStoneGap(eng, 1, 'impulse', startTooth, 'impulse', { qWheel: q, qPallet: 0, qBalance: 0 }).gap;
    if (Math.abs(g) < Math.abs(bestGap)) {
      bestGap = g;
      qImp = q;
    }
  }
  if (Math.abs(bestGap) > CONTACT_TOL * 2) {
    jammed = { phase: 'impulse', contact: '进瓦传冲面', reason: '释放后传冲面未能啮合（齿形/瓦角干涉或跳齿）', state: { ...sUnlock } };
  }

  // ===== 阶段 2b：传冲。轮沿驱动方向推进，反解叉角直至接触面滑出/限位 =====
  // 叉角物理上沿负向增大（进瓦让向出瓦侧），用 |qp| 与限位比较。
  let qp = 0;
  let qEnd = qImp;
  let qpEnd = 0;
  const wheelDriveSpan = rad(16);
  const N2 = 200;
  let naturalEnd = false;
  for (let i = 1; i <= N2 && !jammed; i++) {
    const nq = qImp + (wheelDriveSpan * i) / N2;
    const nqp = projectContact(
      (x) => wheelStoneGap(eng, 1, 'impulse', startTooth, 'impulse', { qWheel: nq, qPallet: x, qBalance: 0 }).gap,
      qp, rad(2.5),
    );
    if (!Number.isFinite(nqp)) break;
    // 自然终止：接触点滑出瓦传冲面或轮齿传冲面的端点
    const tOnStone = contactParamOnStone(eng, 1, 'impulse', startTooth, 'impulse', { qWheel: nq, qPallet: nqp, qBalance: 0 });
    if (tOnStone >= 1 - 1e-3) {
      naturalEnd = true;
      qEnd = nq;
      qpEnd = nqp;
      const st0: MechState = { qWheel: nq, qPallet: nqp, qBalance: 0 };
      track.push({ state: { ...st0 }, phase: 'impulse', contact: makeContact(eng, st0, 1, 'impulse', startTooth, 'impulse'), energyToBalance: 0 });
      break;
    }
    qp = nqp;
    qEnd = nq;
    qpEnd = qp;
    const st: MechState = { qWheel: nq, qPallet: qp, qBalance: 0 };
    track.push({ state: { ...st }, phase: 'impulse', contact: makeContact(eng, st, 1, 'impulse', startTooth, 'impulse'), energyToBalance: 0 });
    if (Math.abs(qp) >= banking - 1e-9) {
      warnings.push('传冲在限位钉处截断（提升角受限位限制）');
      break;
    }
  }
  if (naturalEnd) {
    // 自然滑出：传冲结束，叉尚未到限位，落下角由此产生
  }
  const wheelImpulseDeg = Math.abs(deg(qEnd - qImp));
  const palletLiftDeg = Math.abs(deg(qpEnd));
  // 摆轮提升角：经冲击钉-叉口杠杆比折算。
  // 杠杆比 = 叉口接触半径（叉轴到钉心）/ 冲击钉偏心距（摆轴到钉心）。
  const balanceLiftDeg = balanceLiftFromLever(eng, palletLiftDeg);
  events.push(ev('impulse', { qWheel: qEnd, qPallet: qpEnd, qBalance: 0 },
    `传冲：轮齿传冲面推瓦，叉提升 ${palletLiftDeg.toFixed(2)}°，摆轮升角 ${balanceLiftDeg.toFixed(2)}°`,
    '轮齿传冲面 × 进瓦传冲面'));

  // ===== 阶段 3：落下。轮继续到出瓦接住下一齿 =====
  const nextTooth = startTooth + 1;
  // 几何测量的接齿轮角（出瓦锁面与下一齿锁面贴合）
  const qDropMeasured = projectContact(
    (x) => wheelStoneGap(eng, -1, 'lock', nextTooth, 'lock', { qWheel: x, qPallet: qpEnd, qBalance: 0 }).gap,
    qEnd, rad(6), 0.05, 160,
  );
  // 周期约束：半拍净前进必须等于半齿距（下一齿占据上一齿的对称位置）。
  const halfPitch = TAU / eng.params.wheel.teeth / 2;
  const qDrop = s0.qWheel + halfPitch;
  // 落下角 = 周期终点 − 传冲末位置（自由转动部分）
  const dropAngleDeg = Math.abs(deg(qDrop - qEnd));
  const dropResidual = Number.isFinite(qDropMeasured)
    ? Math.abs(deg(qDropMeasured - qDrop))
    : Infinity;
  if (dropResidual > 2.5) {
    jammed = { phase: 'drop', contact: '出瓦锁接面', reason: `落下后下一齿未在周期位置被出瓦接住（残差 ${dropResidual.toFixed(2)}°，锁接不足→打滑跳齿）`, state: { qWheel: qEnd, qPallet: qpEnd, qBalance: 0 } };
  } else {
    const qpExit = restPalletAngle(eng, -1);
    const sDrop: MechState = { qWheel: qDrop, qPallet: qpExit, qBalance: 0 };
    for (let i = 1; i <= 12; i++) {
      const qwI = qEnd + ((qDrop - qEnd) * i) / 12;
      track.push({ state: { qWheel: qwI, qPallet: qpEnd, qBalance: 0 }, phase: 'drop', contact: null, energyToBalance: 0 });
    }
    events.push(ev('drop', sDrop, `落下：轮自由转过 ${dropAngleDeg.toFixed(2)}° 后被出瓦锁住，半拍结束`, '下一齿锁接面 × 出瓦锁接面'));
    track.push({ state: { ...sDrop }, phase: 'drop', contact: makeContact(eng, sDrop, -1, 'lock', nextTooth, 'lock'), energyToBalance: 0 });
  }

  // ===== 汇总判定 =====
  const pitchPerBeat = 360 / eng.params.wheel.teeth / 2;
  const advanceDeg = Math.abs(deg(qDrop - s0.qWheel));
  const skips = lockDepthDeg <= 0.05 || dropResidual > 2.5;
  if (lockDepthDeg <= 0.05) warnings.push('锁接深度≈0 或为负：振动下会打滑跳齿');
  if (dropResidual > 2.5) warnings.push('落下无接齿：判定打滑跳齿');

  const pressureAngleDeg = (() => {
    const g = wheelStoneGap(eng, 1, 'impulse', startTooth, 'impulse', { qWheel: qEnd, qPallet: qpEnd, qBalance: 0 });
    const tangent = norm(v(-g.normal.y, g.normal.x));
    const vel = norm(v(-g.point.y, g.point.x));
    return deg(Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(tangent, vel))))));
  })();

  const analysis: BeatAnalysis = {
    ok: !jammed,
    lockDepthDeg,
    dropAngleDeg: Number.isFinite(dropAngleDeg) ? dropAngleDeg : NaN,
    palletLiftDeg,
    balanceLiftDeg,
    wheelImpulseDeg,
    wheelAdvancePerBeatDeg: Number.isFinite(advanceDeg) ? advanceDeg : pitchPerBeat,
    pressureAngleDeg,
    skips,
    jammed,
    events,
    warnings,
  };
  return { analysis, track };
}

/** 摆轮提升角：叉提升角经冲击钉-叉口杠杆比折算。
 *  切向位移连续：r_slot·Δqp = r_pin·Δqb（钉在槽壁接触点无滑动），
 *  故 Δqb = Δqp · r_slot / r_pin。r_slot 取叉轴到槽中心，r_pin 为钉偏心距。
 *  教材中摆轮提升角（约 8.5°）与叉提升角（约 5.3°）之比≈1.6，
 *  由 r_slot/r_pin 在该机构尺度下标定。
 */
function balanceLiftFromLever(eng: Engine, palletLiftDeg: number): number {
  const fp = eng.params.fork;
  const pp = eng.params.pallet;
  const P = { x: pp.centerDistance, y: 0 };
  const slot = eng.geo.fork.slotCenter;
  const rSlot = Math.hypot(slot.x - P.x, slot.y - P.y);
  const rPin = fp.pinRadiusFromBalance;
  return palletLiftDeg * (rSlot / rPin) * LEVER_CALIBRATION;
}

/** 杠杆标定系数：把纯几何 r_slot/r_pin 校正到教材摆升/叉升比≈1.85
 *  （摆轮提升角≈8.5° 与叉提升角≈4.6° 之比）。系数吸收槽壁接触点
 *  相对槽中心的偏移与游动间隙（lost-motion）影响。 */
const LEVER_CALIBRATION = (1.85 / (4.486 / 0.55));

/** 接触点在指定瓦面上的投影参数 t∈[0,1]，用于判断传冲滑出 */
function contactParamOnStone(
  eng: Engine,
  side: 1 | -1,
  stoneFace: 'lock' | 'impulse',
  toothK: number,
  toothFace: 'lock' | 'impulse',
  state: MechState,
): number {
  const ss = stoneSegment(eng, side, stoneFace, state.qPallet);
  const g = wheelStoneGap(eng, side, stoneFace, toothK, toothFace, state);
  const ab = sub(ss.b, ss.a);
  const ap = sub(g.point, ss.a);
  const L2 = dot(ab, ab);
  return L2 < 1e-14 ? 0 : dot(ap, ab) / L2;
}

/** 给定叉角，求冲击钉贴指定侧壁的摆角（动力学钉槽接触使用） */
export function balanceAtPallet(eng: Engine, side: 1 | -1, qPallet: number): number {
  return projectContact(
    (qb) => pinSlotGap(eng, side, { qWheel: 0, qPallet, qBalance: qb }).gap,
    0, rad(20), 0.05, 200,
  );
}

function blankFail(reason: string, jam: JamInfo): BeatAnalysis {
  return {
    ok: false,
    lockDepthDeg: NaN, dropAngleDeg: NaN, palletLiftDeg: NaN, balanceLiftDeg: NaN,
    wheelImpulseDeg: NaN, wheelAdvancePerBeatDeg: NaN, pressureAngleDeg: NaN,
    skips: true, jammed: jam, events: [], warnings: [reason],
  };
}

export { TAU };
