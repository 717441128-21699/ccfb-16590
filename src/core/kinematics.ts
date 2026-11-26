/**
 * 位姿变换与线段/圆接触原语。
 * 状态角约定：qWheel 顺时针为正（世界旋转取 -qWheel）；
 * qPallet、qBalance 逆时针为正。
 */
import {
  Vec2,
  v,
  sub,
  add,
  scale,
  rot,
  rotAround,
  closestOnSegment,
  segmentIntersection,
  type Segment,
} from './math2d';
import type { MechanismParams, MechState, LabeledPolygon } from './types';
import { palletPivot, balancePivot } from './geometry';

/** 轮上的点：顺时针 qWheel => 旋转 -qWheel */
export function wheelWorld(p: Vec2, qWheel: number): Vec2 {
  return rot(p, -qWheel);
}

/** 叉轴系上的点：逆时针 qPallet */
export function palletWorld(p: Vec2, qPallet: number, params: MechanismParams): Vec2 {
  return rotAround(p, palletPivot(params), qPallet);
}

/** 摆轴系上的点 */
export function balanceWorld(p: Vec2, qBalance: number, params: MechanismParams): Vec2 {
  return rotAround(p, balancePivot(params), qBalance);
}

export function worldSegment(
  seg: Segment,
  body: 'wheel' | 'pallet' | 'balance',
  state: MechState,
  params: MechanismParams,
): Segment {
  const f = (p: Vec2) => {
    if (body === 'wheel') return wheelWorld(p, state.qWheel);
    if (body === 'pallet') return palletWorld(p, state.qPallet, params);
    return balanceWorld(p, state.qBalance, params);
  };
  return { a: f(seg.a), b: f(seg.b) };
}

/** 把多边形变换到世界坐标 */
export function worldPoly(
  poly: LabeledPolygon,
  state: MechState,
  params: MechanismParams,
): Vec2[] {
  return poly.points.map((p) => {
    if (poly.body === 'wheel') return wheelWorld(p, state.qWheel);
    if (poly.body === 'pallet') return palletWorld(p, state.qPallet, params);
    if (poly.body === 'balance') return balanceWorld(p, state.qBalance, params);
    return p;
  });
}

/** 有符号距离：圆（中心 c，半径 r）到线段。gap=距离-r，穿透为负 */
export function circleSegGap(c: Vec2, r: number, s: Segment): {
  gap: number;
  closest: Vec2;
  normal: Vec2;
  t: number;
} {
  const { q, t } = closestOnSegment(c, s);
  const d = sub(c, q);
  const dist = Math.hypot(d.x, d.y);
  const n = dist < 1e-14 ? v(0, -1) : scale(d, 1 / dist);
  return { gap: dist - r, closest: q, normal: n, t };
}

/** 两线段的有符号间隙（相交为负穿透） */
export function segSegGap(s1: Segment, s2: Segment): {
  gap: number;
  p1: Vec2;
  p2: Vec2;
} {
  const hit = segmentIntersection(s1, s2);
  if (hit) {
    const d = Math.min(
      Math.hypot(hit.x - s1.a.x, hit.y - s1.a.y),
      Math.hypot(hit.x - s2.a.x, hit.y - s2.a.y),
    );
    return { gap: -Math.max(d, 1e-6), p1: hit, p2: hit };
  }
  let best = Infinity;
  let bp1 = s1.a;
  let bp2 = s2.a;
  const test = (p: Vec2, s: Segment) => {
    const r = closestOnSegment(p, s);
    const d = Math.hypot(p.x - r.q.x, p.y - r.q.y);
    if (d < best) {
      best = d;
      bp1 = p;
      bp2 = r.q;
    }
  };
  test(s1.a, s2);
  test(s1.b, s2);
  test(s2.a, s1);
  test(s2.b, s1);
  return { gap: best, p1: bp1, p2: bp2 };
}

void add;
