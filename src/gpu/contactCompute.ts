import type { Vec2 } from '../geom/math';

export interface GpuFace {
  a: Vec2;
  b: Vec2;
  faceId: number;
}

export interface GpuPointQuery {
  p: Vec2;
  pointId: number;
}

export interface GpuContactResult {
  point: Vec2;
  nearest: Vec2;
  normal: Vec2;
  distance: number;
  t: number;
  pointId: number;
  faceId: number;
}

const SHADER = /* wgsl */ `
struct QueryPoint {
  pos: vec2f,
  id: u32,
  pad: u32,
};
struct Face {
  a: vec2f,
  b: vec2f,
  id: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
};
struct Contact {
  p: vec2f,
  nearest: vec2f,
  normal: vec2f,
  distance: f32,
  t: f32,
  pointId: u32,
  faceId: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<storage, read> points: array<QueryPoint>;
@group(0) @binding(1) var<storage, read> faces: array<Face>;
@group(0) @binding(2) var<storage, read_write> contacts: array<Contact>;

override POINT_COUNT: u32 = 16u;
override FACE_COUNT: u32 = 16u;

@compute @workgroup_size(16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let pi = gid.x;
  if (pi >= POINT_COUNT) { return; }
  let p = points[pi].pos;
  var best = 1e9;
  var nearest = p;
  var bestT = 0.0;
  var bestFace = 0u;
  var bestNormal = vec2f(0.0, 1.0);

  for (var fi = 0u; fi < FACE_COUNT; fi = fi + 1u) {
    let a = faces[fi].a;
    let b = faces[fi].b;
    let ab = b - a;
    let denom = max(dot(ab, ab), 1e-12);
    var t = dot(p - a, ab) / denom;
    t = clamp(t, 0.0, 1.0);
    let q = a + ab * t;
    let delta = p - q;
    let d = length(delta);
    if (d < best) {
      best = d;
      nearest = q;
      bestT = t;
      bestFace = faces[fi].id;
      if (d > 1e-7) { bestNormal = delta / d; }
      else { bestNormal = normalize(vec2f(-ab.y, ab.x)); }
    }
  }

  contacts[pi].p = p;
  contacts[pi].nearest = nearest;
  contacts[pi].normal = bestNormal;
  contacts[pi].distance = best;
  contacts[pi].t = bestT;
  contacts[pi].pointId = points[pi].id;
  contacts[pi].faceId = bestFace;
}
`;

const MAX_POINTS = 16;
const MAX_FACES = 32;
const CONTACT_FLOATS = 12; // 2+2+2+2 f32 fields packed as 8 f32 + distance,t + 2 u32 reinterpret = 12

export class ContactCompute {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline;
  private bindGroup: GPUBindGroup;
  private pointBuffer: GPUBuffer;
  private faceBuffer: GPUBuffer;
  private contactBuffer: GPUBuffer;
  private readBuffer: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { entryPoint: 'main', module, constants: { POINT_COUNT: MAX_POINTS, FACE_COUNT: MAX_FACES } },
    });
    this.pointBuffer = device.createBuffer({ size: MAX_POINTS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.faceBuffer = device.createBuffer({ size: MAX_FACES * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.contactBuffer = device.createBuffer({ size: MAX_POINTS * CONTACT_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.readBuffer = device.createBuffer({ size: MAX_POINTS * CONTACT_FLOATS * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.pointBuffer } },
        { binding: 1, resource: { buffer: this.faceBuffer } },
        { binding: 2, resource: { buffer: this.contactBuffer } },
      ],
    });
  }

  async query(points: GpuPointQuery[], faces: GpuFace[]): Promise<GpuContactResult[]> {
    const pc = Math.min(points.length, MAX_POINTS);
    const fc = Math.min(faces.length, MAX_FACES);
    const pointData = new ArrayBuffer(MAX_POINTS * 16);
    const pd = new Float32Array(pointData);
    const pu = new Uint32Array(pointData);
    points.slice(0, pc).forEach((q, i) => {
      pd[i * 4] = q.p.x;
      pd[i * 4 + 1] = q.p.y;
      pu[i * 4 + 2] = q.pointId;
    });
    const faceData = new ArrayBuffer(MAX_FACES * 32);
    const fd = new Float32Array(faceData);
    const fu = new Uint32Array(faceData);
    faces.slice(0, fc).forEach((f, i) => {
      fd[i * 8] = f.a.x;
      fd[i * 8 + 1] = f.a.y;
      fd[i * 8 + 2] = f.b.x;
      fd[i * 8 + 3] = f.b.y;
      fu[i * 8 + 4] = f.faceId;
    });
    this.device.queue.writeBuffer(this.pointBuffer, 0, pointData);
    this.device.queue.writeBuffer(this.faceBuffer, 0, faceData);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(this.contactBuffer, 0, this.readBuffer, 0, pc * CONTACT_FLOATS * 4);
    this.device.queue.submit([encoder.finish()]);

    await this.readBuffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(this.readBuffer.getMappedRange().slice(0));
    this.readBuffer.unmap();
    const f32 = new Float32Array(bytes.buffer);
    const u32 = new Uint32Array(bytes.buffer);
    const results: GpuContactResult[] = [];
    for (let i = 0; i < pc; i++) {
      const o = i * CONTACT_FLOATS;
      results.push({
        point: { x: f32[o], y: f32[o + 1] },
        nearest: { x: f32[o + 2], y: f32[o + 3] },
        normal: { x: f32[o + 4], y: f32[o + 5] },
        distance: f32[o + 6],
        t: f32[o + 7],
        pointId: u32[o + 8],
        faceId: u32[o + 9],
      });
    }
    return results;
  }
}
