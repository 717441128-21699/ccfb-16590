/**
 * WebGPU 仿真+渲染器。
 *
 * 职责：
 *  - 初始化 device/context，编译 compute 与 render pipeline
 *  - 把 core 生成的棱柱网格上传为 vertex/index buffer
 *  - 每帧从 TS 接触几何收集 contacts，写入 storage buffer，dispatch compute
 *  - 用 view-proj 相机渲染，支持面高亮、剖切、爆炸拆解偏移
 *  - 无 WebGPU 时由调用方回退到 TS 求解器（DynamicsSolver）
 */
import type { MechanismParams, MechState, DynamicContact } from '../core/types';
import type { Engine } from '../core/escapement';
import { wheelWorld, palletWorld, balanceWorld } from '../core/kinematics';
import type { MeshData } from './mesh';
import { SIM_WGSL, RENDER_WGSL } from './shaders';
import {
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  mat4LookAt,
  mat4RotationZ,
  mat4Translation,
  type Mat4,
} from './mat4';

const MAX_CONTACTS = 16;

/** 与 WGSL SimParams 内存布局一致（48 字节，显式对齐） */
interface SimParamsGpu {
  invIWheel: number;
  invIPallet: number;
  invIBalance: number;
  tauWheel: number;
  springK: number;
  mu: number;
  dt: number;
  baumgarte: number;
  solverIters: number;
  contactCount: number;
  pad0: number;
  pad1: number;
}

export interface RenderObject {
  name: string;
  mesh: MeshData;
  body: 'wheel' | 'pallet' | 'balance' | 'fixed';
  /** 爆炸拆解的附加世界位移 */
  explodeOffset: [number, number, number];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  modelBuffer: GPUBuffer;
  modelBindGroup: GPUBindGroup;
}

export interface CameraState {
  azimuth: number;
  elevation: number;
  distance: number;
  target: [number, number, number];
}

export class EscapementRenderer {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  private engine: Engine;
  private params: MechanismParams;
  /** 暴露引擎供接触几何/指标查询 */
  getEngine(): Engine {
    return this.engine;
  }
  private objects: RenderObject[] = [];
  private simPipeline!: GPUComputePipeline;
  private renderPipeline!: GPURenderPipeline;
  private simParamBuffer!: GPUBuffer;
  private stateBuffer!: GPUBuffer;
  private contactBuffer!: GPUBuffer;
  private cameraBuffer!: GPUBuffer;
  private simBindGroup!: GPUBindGroup;
  private renderBindGroup!: GPUBindGroup;
  private depthTexture!: GPUTexture;
  camera: CameraState = {
    azimuth: 0.6,
    elevation: 0.9,
    distance: 16,
    target: [2.7, 1.5, 0],
  };
  highlightFace = 0;
  sliceEnabled = 0;
  sliceZ = 0;

  private constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, engine: Engine) {
    this.device = device;
    this.context = context;
    this.format = format;
    this.engine = engine;
    this.params = engine.params;
  }

  static async create(canvas: HTMLCanvasElement, engine: Engine): Promise<EscapementRenderer> {
    if (!navigator.gpu) throw new Error('WebGPU 不可用');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('找不到 GPU 适配器');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu')!;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'premultiplied' });
    const r = new EscapementRenderer(device, context, format, engine);
    r.initPipelines();
    r.initBuffers();
    r.resize(canvas);
    return r;
  }

  private initPipelines() {
    const simMod = this.device.createShaderModule({ code: SIM_WGSL });
    this.simPipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: { module: simMod, entryPoint: 'step' },
    });

    const vertMod = this.device.createShaderModule({ code: RENDER_WGSL.vertex });
    const fragMod = this.device.createShaderModule({ code: RENDER_WGSL.fragment });
    this.renderPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: vertMod,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 28,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
              { shaderLocation: 2, offset: 24, format: 'float32' },
            ],
          },
        ],
      },
      fragment: { module: fragMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
    });
  }

  private initBuffers() {
    this.simParamBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.stateBuffer = this.device.createBuffer({
      size: 24,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.contactBuffer = this.device.createBuffer({
      // Contact 结构：vec2+vec2+... 填充到 48 字节
      size: MAX_CONTACTS * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cameraBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.simBindGroup = this.device.createBindGroup({
      layout: this.simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.simParamBuffer } },
        { binding: 1, resource: { buffer: this.stateBuffer } },
        { binding: 2, resource: { buffer: this.contactBuffer } },
      ],
    });
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });
  }

  addObject(name: string, mesh: MeshData, body: RenderObject['body'], explodeOffset: [number, number, number] = [0, 0, 0]) {
    const vertexBuffer = this.device.createBuffer({
      size: Math.max(16, mesh.vertices.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices as BufferSource);
    const indexBuffer = this.device.createBuffer({
      size: Math.max(16, mesh.indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(indexBuffer, 0, mesh.indices as BufferSource);
    const modelBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const modelBindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: modelBuffer } }],
    });
    this.objects.push({ name, mesh, body, explodeOffset, vertexBuffer, indexBuffer, modelBuffer, modelBindGroup });
  }

  resize(canvas: HTMLCanvasElement) {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    canvas.width = Math.max(1, Math.floor(w * devicePixelRatio));
    canvas.height = Math.max(1, Math.floor(h * devicePixelRatio));
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** 上传状态与接触并 dispatch 一个 compute 步 */
  dispatchSim(state: MechState, contacts: DynamicContact[], dt: number) {
    const P = this.params;
    const sp: SimParamsGpu = {
      invIWheel: 1 / P.dynamics.wheelInertia,
      invIPallet: 1 / P.dynamics.palletInertia,
      invIBalance: 1 / P.balance.inertia,
      tauWheel: P.dynamics.wheelTorque,
      springK: P.balance.springStiffness,
      mu: P.dynamics.frictionMu,
      dt,
      baumgarte: P.dynamics.restitution,
      solverIters: 12,
      contactCount: Math.min(contacts.length, MAX_CONTACTS),
      pad0: 0,
      pad1: 0,
    };
    this.device.queue.writeBuffer(this.simParamBuffer, 0, new Float32Array([
      sp.invIWheel, sp.invIPallet, sp.invIBalance, sp.tauWheel,
      sp.springK, sp.mu, sp.dt, sp.baumgarte,
    ]) as BufferSource);
    this.device.queue.writeBuffer(this.simParamBuffer, 32, new Uint32Array([sp.solverIters, sp.contactCount, 0, 0]) as BufferSource);
    this.device.queue.writeBuffer(this.stateBuffer, 0, new Float32Array([
      state.qWheel, state.qPallet, state.qBalance, 0, 0, 0,
    ]) as BufferSource);
    // 接触打包（48 字节/条：point.xy, normal.xy, penetration, bodyA(u32), bodyB(u32), j0,j1,j2）
    const cdata = new Float32Array(new ArrayBuffer(MAX_CONTACTS * 48));
    const udata = new Uint32Array(cdata.buffer);
    contacts.slice(0, MAX_CONTACTS).forEach((c, i) => {
      const o = i * 12;
      cdata[o] = c.point.x; cdata[o + 1] = c.point.y;
      cdata[o + 2] = c.normal.x; cdata[o + 3] = c.normal.y;
      cdata[o + 4] = 0; // penetration 由 JS 侧接触几何给出，这里占位
      cdata[o + 9] = 0; cdata[o + 10] = 0; cdata[o + 11] = 0;
      udata[o + 5] = c.bodyA;
      udata[o + 6] = c.bodyB;
    });
    this.device.queue.writeBuffer(this.contactBuffer, 0, cdata);

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.simPipeline);
    pass.setBindGroup(0, this.simBindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** 渲染一帧。state 驱动各刚体转角，explode 0~1 控制拆解 */
  render(state: MechState, explode: number) {
    const canvas = this.context.canvas as HTMLCanvasElement;
    const aspect = canvas.width / canvas.height;
    const proj = mat4Perspective((45 * Math.PI) / 180, aspect, 0.1, 200);
    const az = this.camera.azimuth;
    const el = this.camera.elevation;
    const d = this.camera.distance;
    const eye: [number, number, number] = [
      this.camera.target[0] + d * Math.cos(el) * Math.cos(az),
      this.camera.target[1] + d * Math.cos(el) * Math.sin(az),
      this.camera.target[2] + d * Math.sin(el),
    ];
    const view = mat4LookAt(eye, this.camera.target, [0, 0, 1]);
    const viewProj = mat4Multiply(proj, view);

    const cam = new Float32Array(20);
    cam.set(viewProj, 0);
    cam[16] = this.highlightFace;
    cam[17] = this.sliceZ;
    cam[18] = this.sliceEnabled;
    cam[19] = 0;
    this.device.queue.writeBuffer(this.cameraBuffer, 0, cam);

    const enc = this.device.createCommandEncoder();
    const rp = enc.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.07, g: 0.08, b: 0.11, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    rp.setPipeline(this.renderPipeline);
    rp.setBindGroup(0, this.renderBindGroup);

    for (const obj of this.objects) {
      const model = this.bodyModel(obj.body, state, explode, obj.explodeOffset);
      this.device.queue.writeBuffer(obj.modelBuffer, 0, model as BufferSource);

      rp.setBindGroup(1, obj.modelBindGroup);
      rp.setVertexBuffer(0, obj.vertexBuffer);
      rp.setIndexBuffer(obj.indexBuffer, 'uint32');
      rp.drawIndexed(obj.mesh.indexCount);
    }
    rp.end();
    this.device.queue.submit([enc.finish()]);
  }

  private bodyModel(
    body: RenderObject['body'],
    state: MechState,
    explode: number,
    offset: [number, number, number],
  ): Mat4 {
    let m = mat4Identity();
    if (body === 'wheel') {
      m = mat4Multiply(m, mat4Translation(0, 0, explode * offset[2]));
      m = mat4Multiply(m, mat4RotationZ(-state.qWheel));
    } else if (body === 'pallet') {
      const pivot = { x: this.params.pallet.centerDistance, y: 0 };
      m = mat4Multiply(m, mat4Translation(pivot.x + explode * offset[0], explode * offset[1], explode * offset[2]));
      m = mat4Multiply(m, mat4RotationZ(state.qPallet));
      m = mat4Multiply(m, mat4Translation(-pivot.x, 0, 0));
    } else if (body === 'balance') {
      const pivot = { x: this.params.pallet.centerDistance, y: this.params.fork.balanceDistance };
      m = mat4Multiply(m, mat4Translation(0, 0, explode * offset[2]));
      m = mat4Multiply(m, mat4Translation(pivot.x, pivot.y, 0));
      m = mat4Multiply(m, mat4RotationZ(state.qBalance));
      m = mat4Multiply(m, mat4Translation(-pivot.x, -pivot.y, 0));
    } else {
      m = mat4Translation(explode * offset[0], explode * offset[1], explode * offset[2]);
    }
    return m;
  }
}

// 供 CPU 回退路径复用的世界变换（re-export）
export { wheelWorld, palletWorld, balanceWorld };
