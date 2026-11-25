import { buildLineVertices, buildTriangleVertices, VERTEX_FLOATS } from './meshes';
import { identity, lookAt, multiply, orbitEye, perspective } from './mat4';
import type { PlacedPolygon } from '../geom/types';

const SHADER = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
  section: f32,
  cutZ: f32,
  pad0: f32,
  pad1: f32,
};

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec4f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec4f,
};

@vertex
fn vsMain(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  out.position = uniforms.mvp * vec4f(input.position, 1.0);
  out.world = input.position;
  out.normal = input.normal;
  out.color = input.color;
  return out;
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@fragment
fn fsMain(input: VertexOut) -> @location(0) vec4f {
  if (uniforms.section > 0.5 && input.world.z > uniforms.cutZ) {
    discard;
  }
  let n = normalize(input.normal);
  let key = normalize(vec3f(-0.35, -0.45, 0.82));
  let fill = normalize(vec3f(0.65, 0.35, 0.35));
  let diffuse = 0.34 + 0.56 * abs(dot(n, key)) + 0.16 * max(dot(n, fill), 0.0);
  let rim = pow(1.0 - abs(n.z), 2.0) * 0.12;
  var c = input.color.rgb * diffuse + vec3f(rim);
  return vec4f(c, input.color.a);
}
`;

// WGSL references the uniform before declaration order is accepted, but keep a
// second declaration string out of the entry point for readability.
const SHADER_FIXED = SHADER.replace(
  '@group(0) @binding(0) var<uniform> uniforms: Uniforms;',
  '@group(0) @binding(0) var<uniform> uniforms: Uniforms;',
);

export interface RenderLine {
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  color: [number, number, number, number];
}

export class GpuRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private linePipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private triangleBuffer: GPUBuffer | null = null;
  private lineBuffer: GPUBuffer | null = null;
  private triangleCapacity = 0;
  private lineCapacity = 0;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private viewProj = identity();
  private width = 1;
  private height = 1;

  yaw = -34;
  pitch = 38;
  distance = 28.5;
  target: [number, number, number] = [5.1, 0, 0.25];

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.canvas = canvas;
    this.device = device;
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('当前浏览器无法取得 WebGPU canvas context。');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'premultiplied' });

    const module = device.createShaderModule({ code: SHADER_FIXED });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const vertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: VERTEX_FLOATS * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x4' },
        ],
      },
    ];
    const depthStencil: GPUDepthStencilState = {
      format: 'depth24plus',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };
    const pipelineDesc: GPURenderPipelineDescriptor = {
      layout,
      vertex: { module, entryPoint: 'vsMain', buffers: vertexBuffers },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    };
    this.pipeline = device.createRenderPipeline(pipelineDesc);
    this.linePipeline = device.createRenderPipeline({
      ...pipelineDesc,
      primitive: { topology: 'line-list', cullMode: 'none' },
    } as GPURenderPipelineDescriptor);

    this.uniformBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement): Promise<GpuRenderer> {
    if (!navigator.gpu) throw new Error('NO_WEBGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('NO_ADAPTER');
    const device = await adapter.requestDevice();
    return new GpuRenderer(canvas, device);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.width = Math.max(1, Math.floor(rect.width * dpr));
    this.height = Math.max(1, Math.floor(rect.height * dpr));
    if (this.canvas.width !== this.width || this.canvas.height !== this.height) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [this.width, this.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthView = this.depthTexture.createView();
  }

  private ensureBuffer(which: 'tri' | 'line', requiredFloats: number): GPUBuffer {
    const requiredBytes = Math.max(4096, requiredFloats * 4);
    if (which === 'tri') {
      if (!this.triangleBuffer || this.triangleCapacity < requiredBytes) {
        this.triangleBuffer?.destroy();
        this.triangleCapacity = Math.max(requiredBytes, this.triangleCapacity * 2 || 1 << 20);
        this.triangleBuffer = this.device.createBuffer({ size: this.triangleCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      }
      return this.triangleBuffer;
    }
    if (!this.lineBuffer || this.lineCapacity < requiredBytes) {
      this.lineBuffer?.destroy();
      this.lineCapacity = Math.max(requiredBytes, this.lineCapacity * 2 || 1 << 16);
      this.lineBuffer = this.device.createBuffer({ size: this.lineCapacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    return this.lineBuffer;
  }

  render(polygons: PlacedPolygon[], extraLines: RenderLine[] = [], section = false): void {
    this.resize();
    const triangles = buildTriangleVertices(polygons);
    const outlines = this.buildOutlines(polygons);
    const lines = [...outlines, ...extraLines];
    const lineData = buildLineVertices(lines);

    const aspect = this.width / this.height;
    const proj = perspective(38, aspect, 0.1, 120);
    const eye = orbitEye(this.yaw, this.pitch, this.distance, this.target);
    const view = lookAt(eye, this.target, [0, 0, 1]);
    this.viewProj = multiply(proj, view);
    const uniforms = new Float32Array(20);
    uniforms.set(this.viewProj, 0);
    uniforms[16] = section ? 1 : 0;
    uniforms[17] = 0.24;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    const triBuffer = this.ensureBuffer('tri', triangles.length);
    this.device.queue.writeBuffer(triBuffer, 0, triangles as Float32Array<ArrayBuffer>);
    const lineBuffer = this.ensureBuffer('line', lineData.length);
    this.device.queue.writeBuffer(lineBuffer, 0, lineData as Float32Array<ArrayBuffer>);

    const encoder = this.device.createCommandEncoder();
    const viewTexture = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: viewTexture,
          clearValue: { r: 0.035, g: 0.055, b: 0.085, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthView!,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, triBuffer);
    pass.draw(triangles.length / VERTEX_FLOATS);
    pass.setPipeline(this.linePipeline);
    pass.setVertexBuffer(0, lineBuffer);
    pass.draw(lineData.length / VERTEX_FLOATS);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private buildOutlines(polygons: PlacedPolygon[]): RenderLine[] {
    const lines: RenderLine[] = [];
    for (const p of polygons) {
      if (p.annulus) continue;
      const z = (p.z ?? 0) + (p.thickness ?? 0.2) / 2 + 0.035;
      const color: [number, number, number, number] = [0.02, 0.03, 0.05, 0.8];
      for (let i = 0; i < p.points.length; i++) {
        const a = p.points[i];
        const b = p.points[(i + 1) % p.points.length];
        lines.push({ a: { x: a.x, y: a.y, z }, b: { x: b.x, y: b.y, z }, color });
      }
    }
    return lines;
  }

  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const m = this.viewProj;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.01) return { x: 0, y: 0, visible: false };
    const nx = cx / cw;
    const ny = cy / cw;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (nx * 0.5 + 0.5) * rect.width,
      y: (-ny * 0.5 + 0.5) * rect.height,
      visible: cz / cw >= -1 && cz / cw <= 1,
    };
  }
}
