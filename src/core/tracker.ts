/**
 * 连续接触跟踪器（最小间隙优化法）。
 *
 * 叉瓦/轮齿的传冲面接近平行，刚体接触表现为"单点相切"，间隙在贴合附近
 * 不变号（恒为小正量）。因此用"在局部窗口内最小化 |gap|"求贴合构型，
 * 而非要求 gap 严格过零。每步以前一解为初值，保证解支连续。
 *
 * 对锁接面这类真正会穿透（gap 变号）的约束，最小化 |gap| 同样收敛到 gap=0。
 */
import { rad } from './math2d';
import type { MechState } from './types';
import type { Engine } from './escapement';
import { wheelStoneGap, pinSlotGap } from './escapement';

export type StoneFace = 'lock' | 'impulse';

/** 贴合容差（mm）：最小间隙小于此值即视为保持接触 */
export const CONTACT_TOL = 0.02;

/**
 * 在 guess±half 内找使 |f| 最小的 x。要求最小值 < tol 才返回，否则 NaN。
 * 先粗扫定位区间，再用黄金分割细化。
 */
export function projectContact(
  f: (x: number) => number,
  guess: number,
  half: number,
  tol = CONTACT_TOL,
  samples = 60,
): number {
  let bestX = guess;
  let bestAbs = Infinity;
  for (let i = 0; i <= samples; i++) {
    const x = guess - half + ((2 * half) * i) / samples;
    const y = f(x);
    if (!Number.isFinite(y)) continue;
    if (Math.abs(y) < bestAbs) {
      bestAbs = Math.abs(y);
      bestX = x;
    }
  }
  if (bestAbs > tol) return NaN;
  // 黄金分割细化（最小化 |f|）
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = bestX - half / samples;
  let b = bestX + half / samples;
  let c = b - gr * (b - a);
  let d = a + gr * (b - a);
  for (let it = 0; it < 50; it++) {
    if (Math.abs(f(c)) < Math.abs(f(d))) b = d;
    else a = c;
    c = b - gr * (b - a);
    d = a + gr * (b - a);
    if (b - a < 1e-12) break;
  }
  const xm = 0.5 * (a + b);
  return Math.abs(f(xm)) <= tol ? xm : bestX;
}

export interface TrackedContact {
  states: MechState[];
  gaps: number[];
  detachIndex: number;
}

/**
 * 以叉角 qPallet 为主动量，跟踪轮齿面贴瓦面，解连续轮角。
 */
export function trackWheelStone(
  eng: Engine,
  side: 1 | -1,
  stoneFace: StoneFace,
  toothK: number,
  toothFace: StoneFace,
  qp0: number,
  qp1: number,
  qWheel0: number,
  n = 160,
): TrackedContact {
  const states: MechState[] = [];
  const gaps: number[] = [];
  let detachIndex = -1;
  let prevQw = qWheel0;
  for (let i = 0; i <= n; i++) {
    const qp = qp0 + ((qp1 - qp0) * i) / n;
    const f = (qw: number) =>
      wheelStoneGap(eng, side, stoneFace, toothK, toothFace, {
        qWheel: qw,
        qPallet: qp,
        qBalance: 0,
      }).gap;
    const qw = projectContact(f, prevQw, rad(3));
    if (!Number.isFinite(qw)) {
      detachIndex = i;
      break;
    }
    const g = f(qw);
    states.push({ qWheel: qw, qPallet: qp, qBalance: 0 });
    gaps.push(g);
    prevQw = qw;
  }
  return { states, gaps, detachIndex };
}

/**
 * 以叉角为主动量，跟踪冲击钉贴叉口壁，解连续摆角。
 */
export function trackPinSlot(
  eng: Engine,
  side: 1 | -1,
  qp0: number,
  qp1: number,
  qBalance0: number,
  n = 160,
): TrackedContact {
  const states: MechState[] = [];
  const gaps: number[] = [];
  let detachIndex = -1;
  let prevQb = qBalance0;
  for (let i = 0; i <= n; i++) {
    const qp = qp0 + ((qp1 - qp0) * i) / n;
    const f = (qb: number) =>
      pinSlotGap(eng, side, { qWheel: 0, qPallet: qp, qBalance: qb }).gap;
    const qb = projectContact(f, prevQb, rad(4));
    if (!Number.isFinite(qb)) {
      detachIndex = i;
      break;
    }
    const g = f(qb);
    states.push({ qWheel: 0, qPallet: qp, qBalance: qb });
    gaps.push(g);
    prevQb = qb;
  }
  return { states, gaps, detachIndex };
}

/**
 * 以轮角为主动量，跟踪轮齿面贴瓦面，反解连续叉角（传冲阶段轮驱动）。
 */
export function trackPalletByWheel(
  eng: Engine,
  side: 1 | -1,
  stoneFace: StoneFace,
  toothK: number,
  toothFace: StoneFace,
  qWheel0: number,
  qWheel1: number,
  qPallet0: number,
  n = 120,
): TrackedContact {
  const states: MechState[] = [];
  const gaps: number[] = [];
  let detachIndex = -1;
  let prevQp = qPallet0;
  for (let i = 0; i <= n; i++) {
    const qw = qWheel0 + ((qWheel1 - qWheel0) * i) / n;
    const f = (qp: number) =>
      wheelStoneGap(eng, side, stoneFace, toothK, toothFace, {
        qWheel: qw,
        qPallet: qp,
        qBalance: 0,
      }).gap;
    const qp = projectContact(f, prevQp, rad(2.5));
    if (!Number.isFinite(qp)) {
      detachIndex = i;
      break;
    }
    const g = f(qp);
    states.push({ qWheel: qw, qPallet: qp, qBalance: 0 });
    gaps.push(g);
    prevQp = qp;
  }
  return { states, gaps, detachIndex };
}
