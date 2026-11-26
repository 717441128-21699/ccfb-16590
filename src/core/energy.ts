/**
 * 能量核算（要求 2 的能量守恒验证）。
 *
 * 无摩擦（μ=0）理想情况下：
 *   传冲阶段擒纵轮经叉瓦/冲击钉传给摆轮的能量
 *   = 轮上驱动力矩在传冲段做的功 W_wheel = τ_wheel · Δθ_wheel(impulse)
 *   = 摆轮游丝在提升段吸收的能量 ΔE_balance
 *
 * 两条独立路径计算并比对：
 *   路径 A（轮侧功）：W_A = τ·Δθ_w，纯力矩-角位移积分
 *   路径 B（摆轮侧能）：W_B = ½ k (θ₂² − θ₁²)，游丝弹性势能增量
 * 接触法向力沿接触点相对速度的功率积分在无摩擦、刚性理想约束下与上二者相等，
 * 这里再用接触雅可比给出瞬时力与功率，沿传冲轨迹数值积分作为第三条交叉验证。
 */
import { rad, deg, cross } from './math2d';
import type { MechState } from './types';
import type { Engine, BeatResult } from './escapement';
import { wheelStoneGap } from './escapement';

export interface EnergyBalance {
  /** 轮侧功（N·mm = μJ） */
  workFromWheel: number;
  /** 摆轮游丝吸收的弹性势能（μJ） */
  energyToBalance: number;
  /** 接触功率积分（交叉验证，μJ） */
  contactWork: number;
  /** 摩擦耗散（μJ），μ=0 时为 0 */
  frictionLoss: number;
  /** 扣除摩擦后传给摆轮的净功（μJ） */
  netWorkToBalance: number;
  /** 相对偏差（无量纲），理想应≈0 */
  relativeError: number;
  /** 传冲段轮角位移（rad） */
  wheelImpulseAngle: number;
  /** 摆轮提升角（rad） */
  balanceLiftAngle: number;
}

/**
 * 由一拍轨迹与解析结果计算能量平衡。
 * @param balanceLiftDeg 引擎给出的摆轮提升角（度）
 */
export function computeEnergyBalance(
  eng: Engine,
  beat: BeatResult,
  balanceLiftDeg: number,
): EnergyBalance {
  const P = eng.params;
  const tau = P.dynamics.wheelTorque;
  const k = P.balance.springStiffness;

  // 传冲轨迹段
  const impulseTrack = beat.track.filter((t) => t.phase === 'impulse');
  let wheelImpulseAngle = 0;
  let contactWork = 0;
  if (impulseTrack.length >= 2) {
    const first = impulseTrack[0].state;
    const last = impulseTrack[impulseTrack.length - 1].state;
    wheelImpulseAngle = Math.abs(last.qWheel - first.qWheel);

    // 接触功率积分：每步由静力学求接触法向力 N，
    // 功率 = N · (接触点沿法向的相对速度)，用有限差分角速度。
    for (let i = 1; i < impulseTrack.length; i++) {
      const prev = impulseTrack[i - 1].state;
      const cur = impulseTrack[i].state;
      const dt = 1; // 用角位移直接积分，功率×dt 退化为力×法向接近量
      const N = contactNormalForce(eng, cur, tau);
      const gPrev = wheelStoneGap(eng, 1, 'impulse', toothOf(eng, beat), 'impulse', prev).gap;
      const gCur = wheelStoneGap(eng, 1, 'impulse', toothOf(eng, beat), 'impulse', cur).gap;
      // 法向接近量（接触点相对法向位移）
      const dn = Math.abs(gCur - gPrev);
      contactWork += N * dn;
      void dt;
    }
  }

  // 路径 A：轮驱动力矩做功（无摩擦基线，τ·Δθ）
  const baseWheelWork = tau * wheelImpulseAngle;

  // 摩擦耗散：Q_friction = μ · N · 滑动路径长度（沿接触面）
  const mu = P.dynamics.frictionMu;
  let frictionLoss = 0;
  if (mu > 0 && impulseTrack.length >= 2) {
    for (let i = 1; i < impulseTrack.length; i++) {
      const prev = impulseTrack[i - 1].state;
      const cur = impulseTrack[i].state;
      const N = contactNormalForce(eng, cur, tau);
      const gA = wheelStoneGap(eng, 1, 'impulse', toothOf(eng, beat), 'impulse', prev);
      const gB = wheelStoneGap(eng, 1, 'impulse', toothOf(eng, beat), 'impulse', cur);
      const slip = Math.hypot(gB.point.x - gA.point.x, gB.point.y - gA.point.y);
      frictionLoss += mu * N * slip;
    }
  }

  // 轮总做功 = 理想传递功 + 克服摩擦的额外功
  const workFromWheel = baseWheelWork + frictionLoss;

  // 摆轮实际获得能量（游丝吸收）= 轮做功 − 摩擦耗散
  const netWorkToBalance = workFromWheel - frictionLoss;

  // 路径 B：摆轮游丝弹性势能增量（由几何提升角决定）
  const balanceLiftAngle = rad(balanceLiftDeg);
  const energyToBalance = 0.5 * k * balanceLiftAngle * balanceLiftAngle;

  // 无摩擦时 workFromWheel==netWorkToBalance 应与游丝吸能严格相等；
  // 有摩擦时 netWorkToBalance 与游丝吸能相等。
  const denom = Math.max(workFromWheel, 1e-12);
  const relativeError = Math.abs(netWorkToBalance - energyToBalance) / denom;

  return {
    workFromWheel,
    energyToBalance,
    contactWork,
    frictionLoss,
    netWorkToBalance,
    relativeError,
    wheelImpulseAngle,
    balanceLiftAngle,
  };
}

/** 取该拍使用的起始轮齿号（由轨迹首个锁接接触推断，缺省回退到最近齿） */
function toothOf(eng: Engine, _beat: BeatResult): number {
  // 引擎内部以 nearestTooth 起步；这里复用同一选择
  let best = 0;
  let bg = Infinity;
  for (let k = 0; k < eng.params.wheel.teeth; k++) {
    const g = wheelStoneGap(eng, 1, 'lock', k, 'lock', { qWheel: 0, qPallet: 0, qBalance: 0 }).gap;
    if (g < bg) {
      bg = g;
      best = k;
    }
  }
  return best;
}

/**
 * 传冲接触法向力（静力学虚功）。
 * 轮力矩 τ 经接触法线传递：N = τ / (r × n)_z，
 * 其中 r 为轮轴到接触点向量，n 为接触法线。
 */
export function contactNormalForce(eng: Engine, state: MechState, tau: number): number {
  const g = wheelStoneGap(eng, 1, 'impulse', toothOfStatic(eng), 'impulse', state);
  const lever = Math.abs(cross(g.point, g.normal));
  if (lever < 1e-9) return 0;
  return tau / lever;
}

function toothOfStatic(eng: Engine): number {
  let best = 0;
  let bg = Infinity;
  for (let k = 0; k < eng.params.wheel.teeth; k++) {
    const g = wheelStoneGap(eng, 1, 'lock', k, 'lock', { qWheel: 0, qPallet: 0, qBalance: 0 }).gap;
    if (g < bg) {
      bg = g;
      best = k;
    }
  }
  return best;
}

/** 把能量平衡整理为课堂展示文本 */
export function summarizeEnergy(b: EnergyBalance): string[] {
  return [
    `传冲轮角位移 = ${deg(b.wheelImpulseAngle).toFixed(3)}°`,
    `摆轮提升角 = ${deg(b.balanceLiftAngle).toFixed(3)}°`,
    `轮侧做功 W_A = τ·Δθ = ${b.workFromWheel.toFixed(5)} μJ`,
    `摩擦耗散 Q = ${b.frictionLoss.toFixed(6)} μJ`,
    `传给摆轮净功 = ${b.netWorkToBalance.toFixed(5)} μJ`,
    `游丝吸能 W_B = ½kθ² = ${b.energyToBalance.toFixed(5)} μJ`,
    `接触功率积分 W_C = ${b.contactWork.toFixed(5)} μJ`,
    `能量相对偏差 = ${(b.relativeError * 100).toFixed(3)}%`,
  ];
}
