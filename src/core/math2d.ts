/**
 * 2D 几何数学基础 —— 全机构接触计算的单事实源。
 * 同一套约定（向量叉积符号、SAT 法线方向）同时被 TS 解析引擎、
 * TS 参考求解器与 WGSL compute 求解器使用，保证三者结果一致。
 *
 * 单位约定：长度 mm，角度内部一律 rad（界面显示再转 deg）。
 * 叉积 cross(a,b) = a.x*b.y - a.y*b.x，逆时针为正。
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
/** 向量左侧（逆时针 90°）法向 */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-14 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
export const rot = (a: Vec2, ang: number): Vec2 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};
export const rotAround = (p: Vec2, c: Vec2, ang: number): Vec2 =>
  add(c, rot(sub(p, c), ang));
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromPolar = (r: number, ang: number): Vec2 => ({
  x: r * Math.cos(ang),
  y: r * Math.sin(ang),
});

export const DEG = Math.PI / 180;
export const deg = (rad: number): number => rad / DEG;
export const rad = (d: number): number => d * DEG;
/** 归一化到 [-PI, PI] */
export const wrapPi = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

export interface Segment {
  a: Vec2;
  b: Vec2;
}

/** 点到线段的最近点，返回最近点与参数 t∈[0,1] */
export function closestOnSegment(p: Vec2, s: Segment): { q: Vec2; t: number } {
  const ab = sub(s.b, s.a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-18 ? 0 : clamp(dot(sub(p, s.a), ab) / l2, 0, 1);
  return { q: lerp(s.a, s.b, t), t };
}

/** 两线段之间最近点对（端点-端点 / 端点-边），返回距离与两点 */
export function closestSegmentPair(s1: Segment, s2: Segment): {
  d: number;
  p1: Vec2;
  p2: Vec2;
} {
  const in1 = segmentIntersection(s1, s2);
  if (in1) return { d: 0, p1: in1, p2: in1 };
  const cands: Array<{ p1: Vec2; p2: Vec2 }> = [];
  const c1 = closestOnSegment(s1.a, s2);
  cands.push({ p1: s1.a, p2: c1.q });
  const c2 = closestOnSegment(s1.b, s2);
  cands.push({ p1: s1.b, p2: c2.q });
  const c3 = closestOnSegment(s2.a, s1);
  cands.push({ p1: c3.q, p2: s2.a });
  const c4 = closestOnSegment(s2.b, s1);
  cands.push({ p1: c4.q, p2: s2.b });
  let best = cands[0];
  let bd = dist(best.p1, best.p2);
  for (const c of cands) {
    const d = dist(c.p1, c.p2);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return { d: bd, p1: best.p1, p2: best.p2 };
}

/** 严格线段相交（不含端点共线），返回交点或 null */
export function segmentIntersection(s1: Segment, s2: Segment): Vec2 | null {
  const r = sub(s1.b, s1.a);
  const s = sub(s2.b, s2.a);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-14) return null;
  const t = cross(sub(s2.a, s1.a), s) / denom;
  const u = cross(sub(s2.a, s1.a), r) / denom;
  if (t > 1e-10 && t < 1 - 1e-10 && u > 1e-10 && u < 1 - 1e-10) {
    return lerp(s1.a, s1.b, t);
  }
  return null;
}

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** 二分求根：f(lo) 与 f(hi) 异号，返回 f≈0 的自变量 */
export function bisect(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-10,
  maxIter = 80,
): number {
  let flo = f(lo);
  let fhi = f(hi);
  if (Math.abs(flo) < tol) return lo;
  if (Math.abs(fhi) < tol) return hi;
  if (flo * fhi > 0) {
    // 退化为网格扫描找异号区间
    const N = 200;
    let prevX = lo;
    let prevY = flo;
    for (let i = 1; i <= N; i++) {
      const x = lo + ((hi - lo) * i) / N;
      const y = f(x);
      if (prevY * y <= 0) {
        hi = x;
        fhi = y;
        lo = prevX;
        flo = prevY;
        break;
      }
      prevX = x;
      prevY = y;
    }
    if (flo * fhi > 0) return NaN;
  }
  for (let i = 0; i < maxIter; i++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (Math.abs(fm) < tol || (hi - lo) * 0.5 < tol) return mid;
    if (flo * fm <= 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return 0.5 * (lo + hi);
}

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += cross(p, q);
  }
  return 0.5 * a;
}

export function isConvex(poly: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = poly[(i + 2) % poly.length];
    const cr = cross(sub(b, a), sub(c, b));
    if (Math.abs(cr) < 1e-12) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 点是否在凸多边形内（边法线均指向外侧时，顶点逆时针） */
export function pointInConvex(p: Vec2, poly: Vec2[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (cross(sub(b, a), sub(p, a)) < -1e-11) return false;
  }
  return true;
}

export interface ContactManifold {
  /** 法线：从 B 指向 A（把 A 推出 B 的方向），单位向量 */
  normal: Vec2;
  /** 穿透深度（mm），未接触时为负的间隙 */
  penetration: number;
  /** A 上的接触点（世界坐标） */
  pointA: Vec2;
  /** B 上的接触点（世界坐标） */
  pointB: Vec2;
}

/**
 * 两个凸多边形的 SAT 接触检测。
 * polyA/polyB 为世界坐标、顶点逆时针。
 * 无接触返回 null。
 */
export function satContact(polyA: Vec2[], polyB: Vec2[]): ContactManifold | null {
  let minOverlap = Infinity;
  let bestNormal: Vec2 = v(0, 0);
  const axes: Vec2[] = [];
  const collectAxes = (poly: Vec2[]) => {
    for (let i = 0; i < poly.length; i++) {
      const e = sub(poly[(i + 1) % poly.length], poly[i]);
      axes.push(norm(perp(e))); // 逆时针多边形，perp 指向外
    }
  };
  collectAxes(polyA);
  collectAxes(polyB);
  const project = (poly: Vec2[], axis: Vec2) => {
    let mn = Infinity;
    let mx = -Infinity;
    for (const p of poly) {
      const d = dot(p, axis);
      mn = Math.min(mn, d);
      mx = Math.max(mx, d);
    }
    return { mn, mx };
  };
  for (const axis0 of axes) {
    // 轴方向取一致：由 B 中心指向 A 中心
    const cA = polyCentroid(polyA);
    const cB = polyCentroid(polyB);
    const axis = dot(axis0, sub(cA, cB)) >= 0 ? axis0 : scale(axis0, -1);
    const pa = project(polyA, axis);
    const pb = project(polyB, axis);
    const overlap = Math.min(pa.mx, pb.mx) - Math.max(pa.mn, pb.mn);
    if (overlap <= 0) return null; // 存在分离轴
    if (overlap < minOverlap) {
      minOverlap = overlap;
      bestNormal = axis;
    }
  }
  // 用最佳分离轴求接触点：取被支撑边的端点在另一多边形边上的裁剪点
  const refA = supportFace(polyA, bestNormal);
  const refB = supportFace(polyB, scale(bestNormal, -1));
  const pts: Vec2[] = [];
  for (const p of [refA.a, refA.b, refB.a, refB.b]) {
    if (pointInConvex(p, polyA) || pointInConvex(p, polyB)) pts.push(p);
  }
  const incA = closestOnSegment(refA.a, refB);
  const incB = closestOnSegment(refB.b, refA);
  pts.push(incA.q, incB.q);
  // 接触点取最深点：沿法线投影最小的两个点的均值
  pts.sort((p, q) => dot(p, bestNormal) - dot(q, bestNormal));
  const pointA = pts[0];
  const pointB = add(pointA, scale(bestNormal, -minOverlap));
  return { normal: bestNormal, penetration: minOverlap, pointA, pointB };
}

function supportFace(poly: Vec2[], axis: Vec2): Segment {
  let best = -Infinity;
  let idx = 0;
  for (let i = 0; i < poly.length; i++) {
    const d = dot(poly[i], axis);
    if (d > best) {
      best = d;
      idx = i;
    }
  }
  const a = poly[idx];
  const b = poly[(idx + 1) % poly.length];
  const c = poly[(idx + poly.length - 1) % poly.length];
  return Math.abs(dot(sub(b, a), axis)) > Math.abs(dot(sub(a, c), axis))
    ? { a, b }
    : { a: c, b: a };
}

export function polyCentroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** 多边形整体平移到世界坐标 */
export function transformPoly(local: Vec2[], center: Vec2, ang: number): Vec2[] {
  return local.map((p) => rotAround(p, center, ang));
}

export const TAU = Math.PI * 2;
