/**
 * WGSL compute 求解器：与 src/core/dynamics.ts 同算法的 GPU 实现。
 *
 * 单 workgroup 推进机构一个时间步：
 *   1. 力矩积分得试探角速度
 *   2. 接触约束（法向 + 库仑摩擦）顺序冲量迭代
 *   3. 位置积分
 * 接触法线/雅可比由 JS 侧从线段几何算出后通过 storage buffer 传入，
 * 保证 GPU 与 CPU 用同一套接触几何（单事实源）。
 */
export const SIM_WGSL = /* wgsl */ `
struct SimParams {
  invIWheel : f32,
  invIPallet : f32,
  invIBalance : f32,
  tauWheel : f32,
  springK : f32,
  mu : f32,
  dt : f32,
  baumgarte : f32,
  solverIters : u32,
  contactCount : u32,
  _pad0 : f32,
  _pad1 : f32,
};

struct State {
  qWheel : f32, qPallet : f32, qBalance : f32,
  wWheel : f32, wPallet : f32, wBalance : f32,
};

// 每个接触：bodyA/bodyB + 接触点 + 法线 + 穿透 + 雅可比 j[3]
struct Contact {
  point : vec2<f32>,
  normal : vec2<f32>,
  penetration : f32,
  bodyA : u32,
  bodyB : u32,
  j0 : f32, j1 : f32, j2 : f32,
};

@group(0) @binding(0) var<uniform> params : SimParams;
@group(0) @binding(1) var<storage, read_write> state : State;
@group(0) @binding(2) var<storage, read> contacts : array<Contact>;

fn invMassOf(b : u32) -> f32 {
  if (b == 0u) { return params.invIWheel; }
  if (b == 1u) { return params.invIPallet; }
  return params.invIBalance;
}

fn jacOf(c : Contact, b : u32) -> f32 {
  if (b == 0u) { return c.j0; }
  if (b == 1u) { return c.j1; }
  return c.j2;
}

@compute @workgroup_size(1)
fn step() {
  // 1) 力矩 -> 试探角速度
  var w : array<f32, 3>;
  w[0] = state.wWheel + params.tauWheel * params.invIWheel * params.dt;
  w[1] = state.wPallet;
  w[2] = state.wBalance + (-params.springK * state.qBalance) * params.invIBalance * params.dt;

  let n : u32 = min(params.contactCount, arrayLength(&contacts));

  // 2) 顺序冲量
  for (var it : u32 = 0u; it < params.solverIters; it++) {
    for (var ci : u32 = 0u; ci < n; ci++) {
      let c = contacts[ci];
      // 有效逆质量
      var effInv : f32 = 0.0;
      for (var b : u32 = 0u; b < 3u; b++) {
        let jb = jacOf(c, b);
        effInv = effInv + jb * jb * invMassOf(b);
      }
      if (effInv < 1e-12) { continue; }

      // 法向约束
      let cDot = c.j0 * w[0] + c.j1 * w[1] + c.j2 * w[2];
      let bias = params.baumgarte * (c.penetration / params.dt) * 0.5;
      let lambda = -(cDot + bias) / effInv;
      for (var b : u32 = 0u; b < 3u; b++) {
        w[b] = w[b] + invMassOf(b) * jacOf(c, b) * lambda;
      }

      // 库仑摩擦（切向雅可比由法线旋转 90° 等效，复用接触点几何在 JS 预算）
      if (params.mu > 0.0) {
        // 切向冲量上限 = μ|λ|；切向相对速度近似用法向雅可比正交分量
        let maxFric = params.mu * abs(lambda);
        // 简化稳定摩擦：对相对速度施加与冲量成比例的阻尼冲量
        let tRel = c.j0 * w[0] - c.j2 * w[2];
        var lambdaT = clamp(-tRel / max(effInv, 1e-12), -maxFric, maxFric);
        w[0] = w[0] + params.invIWheel * c.j0 * lambdaT;
        w[2] = w[2] - params.invIBalance * c.j2 * lambdaT;
      }
    }
  }

  // 3) 位置积分
  state.qWheel = state.qWheel + w[0] * params.dt;
  state.qPallet = state.qPallet + w[1] * params.dt;
  state.qBalance = state.qBalance + w[2] * params.dt;
  state.wWheel = w[0];
  state.wPallet = w[1];
  state.wBalance = w[2];
}
`;

/** 渲染用 WGSL：相机/模型 uniform + 实体着色 + 面语义高亮 */
export const RENDER_WGSL = {
  vertex: /* wgsl */ `
struct Camera {
  viewProj : mat4x4<f32>,
  highlightFace : f32,
  sliceZ : f32,
  sliceEnabled : f32,
  _pad : f32,
};
@group(0) @binding(0) var<uniform> camera : Camera;
struct Model {
  model : mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> modelBuf : Model;
struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) normal : vec3<f32>,
  @location(1) faceId : f32,
  @location(2) localZ : f32,
};
@vertex fn vs(@location(0) position : vec3<f32>,
              @location(1) normal : vec3<f32>,
              @location(2) faceId : f32) -> VSOut {
  var out : VSOut;
  let worldPos = modelBuf.model * vec4<f32>(position, 1.0);
  out.pos = camera.viewProj * worldPos;
  out.normal = normal;
  out.faceId = faceId;
  out.localZ = position.z;
  return out;
}
`,
  fragment: /* wgsl */ `
struct Camera {
  viewProj : mat4x4<f32>,
  highlightFace : f32,
  sliceZ : f32,
  sliceEnabled : f32,
  _pad : f32,
};
@group(0) @binding(0) var<uniform> camera : Camera;
@fragment fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // 剖切：丢弃切片一侧的片元
  if (camera.sliceEnabled > 0.5 && in.localZ < camera.sliceZ) {
    discard;
  }
  let baseColor = vec4<f32>(0.72, 0.75, 0.82, 1.0);
  let lockColor = vec4<f32>(0.95, 0.55, 0.25, 1.0);   // 锁接面橙
  let impulseColor = vec4<f32>(0.35, 0.75, 0.95, 1.0); // 传冲面蓝
  var color = baseColor;
  if (in.faceId == 1.0 || in.faceId == 4.0) { color = lockColor; }
  if (in.faceId == 2.0 || in.faceId == 5.0) { color = impulseColor; }
  if (in.faceId == 7.0 || in.faceId == 8.0) { color = vec4<f32>(0.6, 0.85, 0.5, 1.0); }
  // 高亮当前接触的面
  if (camera.highlightFace > 0.5 && abs(in.faceId - camera.highlightFace) < 0.1) {
    color = vec4<f32>(1.0, 0.9, 0.3, 1.0);
  }
  let light = normalize(vec3<f32>(0.4, 0.5, 0.75));
  let shade = 0.45 + 0.55 * abs(dot(normalize(in.normal), light));
  return vec4<f32>(color.rgb * shade, color.a);
}
`,
};
