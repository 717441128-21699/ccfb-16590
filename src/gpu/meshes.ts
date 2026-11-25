import type { PlacedPolygon } from '../geom/types';
import { cross, sub, type Vec2, type Vec3 } from '../geom/math';

export const VERTEX_FLOATS = 10;

function signedArea(points: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const c1 = cross(sub(b, a), sub(p, a));
  const c2 = cross(sub(c, b), sub(p, b));
  const c3 = cross(sub(a, c), sub(p, c));
  const hasNeg = c1 < -1e-9 || c2 < -1e-9 || c3 < -1e-9;
  const hasPos = c1 > 1e-9 || c2 > 1e-9 || c3 > 1e-9;
  return !(hasNeg && hasPos);
}

export function triangulatePolygon(input: Vec2[]): number[] {
  let points = input.map((p) => ({ ...p }));
  if (points.length < 3) return [];
  if (signedArea(points) < 0) points = points.reverse();
  const indices = points.map((_, i) => i);
  const triangles: number[] = [];
  let guard = 0;

  while (indices.length > 3 && guard++ < 10000) {
    let ear = -1;
    for (let ii = 0; ii < indices.length; ii++) {
      const i0 = indices[(ii - 1 + indices.length) % indices.length];
      const i1 = indices[ii];
      const i2 = indices[(ii + 1) % indices.length];
      const a = points[i0];
      const b = points[i1];
      const c = points[i2];
      if (cross(sub(b, a), sub(c, b)) <= 1e-10) continue;
      let blocked = false;
      for (const idx of indices) {
        if (idx === i0 || idx === i1 || idx === i2) continue;
        if (pointInTriangle(points[idx], a, b, c)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        ear = ii;
        triangles.push(i0, i1, i2);
        break;
      }
    }
    if (ear < 0) {
      // Defensive fan fallback for nearly collinear decorative strips.
      for (let i = 1; i < indices.length - 1; i++) triangles.push(indices[0], indices[i], indices[i + 1]);
      return triangles;
    }
    indices.splice(ear, 1);
  }
  if (indices.length === 3) triangles.push(indices[0], indices[1], indices[2]);
  return triangles;
}

class VertexBuilder {
  data: number[] = [];

  vertex(p: Vec3, n: Vec3, color: [number, number, number, number]): void {
    this.data.push(p.x, p.y, p.z, n.x, n.y, n.z, color[0], color[1], color[2], color[3]);
  }

  tri(a: Vec3, b: Vec3, c: Vec3, n: Vec3, color: [number, number, number, number]): void {
    this.vertex(a, n, color);
    this.vertex(b, n, color);
    this.vertex(c, n, color);
  }
}

function as3(p: Vec2, z: number): Vec3 {
  return { x: p.x, y: p.y, z };
}

export function buildTriangleVertices(polygons: PlacedPolygon[]): Float32Array {
  const b = new VertexBuilder();

  for (const poly of polygons) {
    const baseZ = poly.z ?? 0;
    const thickness = poly.thickness ?? 0.2;
    const zTop = baseZ + thickness / 2;
    const zBottom = baseZ - thickness / 2;
    const color = poly.color;

    if (poly.annulus) {
      const { center, outerRadius: ro, innerRadius: ri, segments } = poly.annulus;
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const o0 = { x: center.x + ro * Math.cos(a0), y: center.y + ro * Math.sin(a0) };
        const o1 = { x: center.x + ro * Math.cos(a1), y: center.y + ro * Math.sin(a1) };
        const i0 = { x: center.x + ri * Math.cos(a0), y: center.y + ri * Math.sin(a0) };
        const i1 = { x: center.x + ri * Math.cos(a1), y: center.y + ri * Math.sin(a1) };
        b.tri(as3(o0, zTop), as3(i1, zTop), as3(o1, zTop), { x: 0, y: 0, z: 1 }, color);
        b.tri(as3(o0, zTop), as3(i0, zTop), as3(i1, zTop), { x: 0, y: 0, z: 1 }, color);
        b.tri(as3(o0, zBottom), as3(o1, zBottom), as3(i1, zBottom), { x: 0, y: 0, z: -1 }, color);
        b.tri(as3(o0, zBottom), as3(i1, zBottom), as3(i0, zBottom), { x: 0, y: 0, z: -1 }, color);
        const no = { x: Math.cos((a0 + a1) / 2), y: Math.sin((a0 + a1) / 2), z: 0 };
        b.tri(as3(o0, zBottom), as3(o0, zTop), as3(o1, zTop), no, color);
        b.tri(as3(o0, zBottom), as3(o1, zTop), as3(o1, zBottom), no, color);
        const ni = { x: -Math.cos((a0 + a1) / 2), y: -Math.sin((a0 + a1) / 2), z: 0 };
        b.tri(as3(i1, zBottom), as3(i1, zTop), as3(i0, zTop), ni, color);
        b.tri(as3(i1, zBottom), as3(i0, zTop), as3(i0, zBottom), ni, color);
      }
      continue;
    }

    const indices = triangulatePolygon(poly.points);
    for (let i = 0; i < indices.length; i += 3) {
      const ia = indices[i];
      const ib = indices[i + 1];
      const ic = indices[i + 2];
      if (ia === undefined || ib === undefined || ic === undefined) continue;
      const a = poly.points[ia];
      const bb = poly.points[ib];
      const c = poly.points[ic];
      b.tri(as3(a, zTop), as3(bb, zTop), as3(c, zTop), { x: 0, y: 0, z: 1 }, color);
      b.tri(as3(a, zBottom), as3(c, zBottom), as3(bb, zBottom), { x: 0, y: 0, z: -1 }, color);
    }

    for (let i = 0; i < poly.points.length; i++) {
      const a = poly.points[i];
      const c = poly.points[(i + 1) % poly.points.length];
      const e = sub(c, a);
      const n2 = { x: e.y, y: -e.x };
      const l = Math.hypot(n2.x, n2.y) || 1;
      const n = { x: n2.x / l, y: n2.y / l, z: 0 };
      b.tri(as3(a, zBottom), as3(a, zTop), as3(c, zTop), n, color);
      b.tri(as3(a, zBottom), as3(c, zTop), as3(c, zBottom), n, color);
    }
  }
  return new Float32Array(b.data);
}

export interface LineVertex {
  p: Vec3;
  color: [number, number, number, number];
}

export function buildLineVertices(lines: Array<{ a: Vec3; b: Vec3; color: [number, number, number, number] }>): Float32Array {
  const out: number[] = [];
  for (const line of lines) {
    for (const p of [line.a, line.b]) {
      out.push(p.x, p.y, p.z, 0, 0, 1, line.color[0], line.color[1], line.color[2], line.color[3]);
    }
  }
  return new Float32Array(out);
}

export function polygonOutlineLines(polys: PlacedPolygon[], zPad = 0.04): Array<{ a: Vec3; b: Vec3; color: [number, number, number, number] }> {
  const lines = [];
  for (const p of polys) {
    if (p.annulus) continue;
    const z = (p.z ?? 0) + (p.thickness ?? 0.2) / 2 + zPad;
    const color: [number, number, number, number] = [0.04, 0.06, 0.09, 0.72];
    for (let i = 0; i < p.points.length; i++) {
      const a = p.points[i];
      const b = p.points[(i + 1) % p.points.length];
      lines.push({ a: { x: a.x, y: a.y, z }, b: { x: b.x, y: b.y, z }, color });
    }
  }
  return lines;
}
