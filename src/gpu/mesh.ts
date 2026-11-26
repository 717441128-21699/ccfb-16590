/**
 * 网格生成：把 2D 凸多边形轮廓沿 z 轴挤出成三角棱柱。
 * 输出 WebGPU 可直接消费的交错顶点（位置 + 法线 + 面语义色）。
 */
import { Vec2, polygonArea } from '../core/math2d';
import type { LabeledPolygon, FaceLabel } from '../core/types';

export interface MeshData {
  /** 交错顶点：position(3) + normal(3) + faceId(1)，每顶点 7 float */
  vertices: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/** 面语义 ID（传到 shader 做高亮/受力着色） */
export const FACE_ID: Record<FaceLabel, number> = {
  'wheel-lock': 1,
  'wheel-impulse': 2,
  'wheel-tip': 3,
  'stone-lock': 4,
  'stone-impulse': 5,
  'stone-discharge': 6,
  'fork-wall-entry': 7,
  'fork-wall-exit': 8,
};

function faceIdOf(label: FaceLabel | null): number {
  return label ? FACE_ID[label] : 0;
}

/**
 * 挤出单个凸多边形。
 * @param depth 棱柱厚度（z 方向）
 */
export function extrudePolygon(poly: LabeledPolygon, depth = 0.35): MeshData {
  const pts = poly.points;
  const n = pts.length;
  const z0 = -depth / 2;
  const z1 = depth / 2;
  const verts: number[] = [];
  const idx: number[] = [];

  const pushV = (p: Vec2, z: number, normal: Vec2, id: number) => {
    verts.push(p.x, p.y, z, normal.x, normal.y, 0, id);
  };

  // 侧面（每条边一个四边形=2三角形），法线用边的外法线
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const e = { x: b.x - a.x, y: b.y - a.y };
    const len = Math.hypot(e.x, e.y);
    // 逆时针多边形，外法线 = (ey, -ex)/len
    const normal = { x: e.y / len, y: -e.x / len };
    const id = faceIdOf(poly.edgeLabels[i]);
    const base = verts.length / 7;
    pushV(a, z0, normal, id);
    pushV(b, z0, normal, id);
    pushV(b, z1, normal, id);
    pushV(a, z1, normal, id);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // 顶面（z1，法线 +z）与底面（z0，法线 -z），用扇形三角化
  const ccw = polygonArea(pts) >= 0;
  const topBase = verts.length / 7;
  for (const p of pts) pushV(p, z1, { x: 0, y: 0 }, 0);
  const botBase = verts.length / 7;
  for (const p of pts) pushV(p, z0, { x: 0, y: 0 }, 0);
  for (let i = 1; i < n - 1; i++) {
    if (ccw) {
      idx.push(topBase, topBase + i, topBase + i + 1);
      idx.push(botBase, botBase + i + 1, botBase + i);
    } else {
      idx.push(topBase, topBase + i + 1, topBase + i);
      idx.push(botBase, botBase + i, botBase + i + 1);
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idx),
    vertexCount: verts.length / 7,
    indexCount: idx.length,
  };
}

/** 线段（如游丝螺旋、受力箭头线）转细管/线框顶点 */
export function lineToVertices(points: Vec2[], z: number, id: number): Float32Array {
  const out: number[] = [];
  for (const p of points) {
    out.push(p.x, p.y, z, 0, 0, 1, id);
  }
  return new Float32Array(out);
}

/** 圆（限位钉、冲击钉）挤出：复用多边形挤出 */
export function extrudeCircle(
  center: Vec2,
  radius: number,
  seg: number,
  depth: number,
  id: number,
): MeshData {
  const pts: Vec2[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  const poly: LabeledPolygon = {
    name: 'circle',
    points: pts,
    edgeLabels: new Array(seg).fill(null),
    body: 'fixed',
    pivot: center,
  };
  const mesh = extrudePolygon(poly, depth);
  // 覆盖侧面 id
  for (let i = 0; i < mesh.vertices.length; i += 7) mesh.vertices[i + 6] = id;
  return mesh;
}
