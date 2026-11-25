export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export const TAU = Math.PI * 2;
export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;

export const v2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const normalize = (a: Vec2): Vec2 => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
};
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export function rot2(p: Vec2, angleRad: number, center: Vec2 = v2()): Vec2 {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const x = p.x - center.x;
  const y = p.y - center.y;
  return { x: center.x + x * c - y * s, y: center.y + x * s + y * c };
}

export function polar(radius: number, angleRad: number, center: Vec2 = v2()): Vec2 {
  return {
    x: center.x + radius * Math.cos(angleRad),
    y: center.y + radius * Math.sin(angleRad),
  };
}

export function angleOf(a: Vec2, center: Vec2 = v2()): number {
  return Math.atan2(a.y - center.y, a.x - center.x);
}

/** Unsigned smallest angle between two directions, in degrees. */
export function angleBetweenDeg(a: Vec2, b: Vec2): number {
  const la = len(a);
  const lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  const cosine = Math.min(1, Math.max(-1, dot(a, b) / (la * lb)));
  return radToDeg(Math.acos(cosine));
}

export function signedAngleDeg(from: Vec2, to: Vec2): number {
  return radToDeg(Math.atan2(cross(from, to), dot(from, to)));
}

export function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function bisect(
  fn: (x: number) => number,
  lo: number,
  hi: number,
  iterations = 48,
): number {
  let flo = fn(lo);
  let fhi = fn(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return (lo + hi) / 2;
  if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    const fm = fn(mid);
    if (Math.abs(fm) < 1e-12) return mid;
    if (flo * fm <= 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
  }
  return (lo + hi) / 2;
}

export type Segment2 = { a: Vec2; b: Vec2; id?: string; material?: string };

export type SegmentContact = {
  p: Vec2;
  normal: Vec2;
  distance: number;
  /** Parameter on first segment [0,1]. */
  t: number;
  /** Parameter on second segment [0,1]. */
  u: number;
  intersects: boolean;
};

/**
 * Segment-segment contact query. For crossing segments it returns the exact
 * intersection; for near-parallel faces it returns their closest points.
 * This is the same reference implementation mirrored by contact.wgsl.ts.
 */
export function segmentContact(s1: Segment2, s2: Segment2): SegmentContact {
  const r = sub(s1.b, s1.a);
  const d = sub(s2.b, s2.a);
  const q = sub(s2.a, s1.a);
  const rCrossD = cross(r, d);

  if (Math.abs(rCrossD) > 1e-10) {
    const t = cross(q, d) / rCrossD;
    const u = cross(q, r) / rCrossD;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const p = add(s1.a, scale(r, t));
      let n = normalize(perp(d));
      const faceToA = sub(s1.a, p);
      if (dot(n, faceToA) < 0) n = scale(n, -1);
      return { p, normal: n, distance: 0, t, u, intersects: true };
    }
  }

  // Closest points for degenerate/non-intersecting cases.
  let best = { dist: Infinity, t: 0, u: 0 };
  const candidates: Array<[number, number]> = [
    [0, clamp(dot(sub(s2.a, s1.a), r) / Math.max(dot(r, r), 1e-12), 0, 1)],
    [1, clamp(dot(sub(s2.b, s1.a), r) / Math.max(dot(r, r), 1e-12), 0, 1)],
    [clamp(dot(sub(s1.a, s2.a), d) / Math.max(dot(d, d), 1e-12), 0, 1), 0],
    [clamp(dot(sub(s1.b, s2.a), d) / Math.max(dot(d, d), 1e-12), 0, 1), 1],
  ];
  for (const [t] of candidates) {
    // Recompute paired parameter with the standard clamped projection.
    const pa = add(s1.a, scale(r, t));
    const u = clamp(dot(sub(pa, s2.a), d) / Math.max(dot(d, d), 1e-12), 0, 1);
    const pb = add(s2.a, scale(d, u));
    const dd = dist(pa, pb);
    if (dd < best.dist) best = { dist: dd, t, u };
  }
  const pa = add(s1.a, scale(r, best.t));
  const pb = add(s2.a, scale(d, best.u));
  const delta = sub(pb, pa);
  const normal = len(delta) > 1e-10 ? normalize(delta) : normalize(perp(r));
  return { p: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, normal, distance: best.dist, t: best.t, u: best.u, intersects: false };
}

export function pointSegmentDistance(p: Vec2, s: Segment2): { distance: number; q: Vec2; t: number } {
  const ab = sub(s.b, s.a);
  const t = clamp(dot(sub(p, s.a), ab) / Math.max(dot(ab, ab), 1e-12), 0, 1);
  const q = add(s.a, scale(ab, t));
  return { distance: dist(p, q), q, t };
}
