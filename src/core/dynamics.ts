/**
 * 动力学求解器（TS 参考实现，WGSL compute 的逐行镜像）。
 *
 * 三个转动刚体（轮 0、叉 1、摆 2），广义速度为角速度 w[3]。
 * 每个接触产生一条速度级约束：J·w + 恢复项 = 0，
 * 用顺序冲量（sequential impulse）迭代求解，摩擦用库仑锥。
 *
 * 主动力矩：轮受恒定发条力矩；摆受游丝回复力矩 -k·q。
 * 接触法线/点由 core 的线段几何实时算出，不是预设动画。
 */
import { Vec2, v, sub, cross, clamp } from './math2d';
import type { MechanismParams, MechState, MechVelocity, DynamicContact } from './types';
import type { Engine } from './escapement';
import {
  wheelStoneGap,
  pinSlotGap,
  nearestTooth,
} from './escapement';

interface RawContact {
  bodyA: number;
  bodyB: number;
  point: Vec2;
  normal: Vec2; // 由 B 指向 A
  penetration: number;
  label: string;
  /** 雅可比：各体角速度对间隙变化的贡献系数 */
  j: [number, number, number];
}

export interface DynamicsStep {
  state: MechState;
  velocity: MechVelocity;
  contacts: DynamicContact[];
  /** 本步传给摆轮的能量增量（μJ） */
  energyToBalance: number;
  jammed: boolean;
}

const SOLVER_ITERS = 12;
const BAUMGARTE = 0.15;

export class DynamicsSolver {
  private eng: Engine;
  private params: MechanismParams;
  q: MechState;
  w: MechVelocity;
  private invMass: [number, number, number];
  energyToBalance = 0;

  constructor(eng: Engine, q0: MechState) {
    this.eng = eng;
    this.params = eng.params;
    this.q = { ...q0 };
    this.w = { wWheel: 0, wPallet: 0, wBalance: 0 };
    this.invMass = [
      1 / this.params.dynamics.wheelInertia,
      1 / this.params.dynamics.palletInertia,
      1 / this.params.balance.inertia,
    ];
  }

  /** 收集当前构型下全部活动接触（轮-叉瓦、钉-叉口） */
  private collectContacts(): RawContact[] {
    const out: RawContact[] = [];
    const eng = this.eng;
    const s = this.q;
    const k = nearestTooth(eng, 1);

    // 轮齿 × 两瓦的锁面/传冲面（命名面接触）
    for (const side of [1, -1] as const) {
      for (const sf of ['lock', 'impulse'] as const) {
        for (const tf of ['lock', 'impulse'] as const) {
          const g = wheelStoneGap(eng, side, sf, k, tf, s);
          if (g.gap < 0.04) {
            const j = this.numericJacobian((st) =>
              wheelStoneGap(eng, side, sf, k, tf, st).gap,
            );
            out.push({
              bodyA: 0,
              bodyB: 1,
              point: g.point,
              normal: g.normal,
              penetration: -g.gap,
              label: g.label,
              j,
            });
          }
        }
      }
    }
    // 冲击钉 × 叉口两壁
    for (const side of [1, -1] as const) {
      const g = pinSlotGap(eng, side, s);
      if (g.gap < 0.04) {
        const j = this.numericJacobian((st) => pinSlotGap(eng, side, st).gap);
        out.push({
          bodyA: 2,
          bodyB: 1,
          point: g.point,
          normal: g.normal,
          penetration: -g.gap,
          label: g.label,
          j,
        });
      }
    }
    return out;
  }

  private numericJacobian(gapFn: (s: MechState) => number): [number, number, number] {
    const eps = 1e-8;
    const g0 = gapFn(this.q);
    const jw = (gapFn({ ...this.q, qWheel: this.q.qWheel + eps }) - g0) / eps;
    const jp = (gapFn({ ...this.q, qPallet: this.q.qPallet + eps }) - g0) / eps;
    const jb = (gapFn({ ...this.q, qBalance: this.q.qBalance + eps }) - g0) / eps;
    return [jw, jp, jb];
  }

  /** 推进一步（dt 秒），半隐式欧拉 + 顺序冲量 */
  step(dt: number): DynamicsStep {
    const P = this.params;
    // 1) 力矩积分得试探速度
    const tau: [number, number, number] = [
      P.dynamics.wheelTorque, // 轮：发条驱动力矩（驱动方向）
      0, // 叉：无独立力矩
      -P.balance.springStiffness * this.q.qBalance, // 摆：游丝回复
    ];
    let w: [number, number, number] = [
      this.w.wWheel + tau[0] * this.invMass[0] * dt,
      this.w.wPallet + tau[1] * this.invMass[1] * dt,
      this.w.wBalance + tau[2] * this.invMass[2] * dt,
    ];

    const contacts = this.collectContacts();

    // 2) 顺序冲量解速度约束（含 Baumgarte 稳定项与摩擦）
    for (let it = 0; it < SOLVER_ITERS; it++) {
      for (const c of contacts) {
        const j = c.j;
        // 有效逆质量
        let effInv = 0;
        for (let b = 0; b < 3; b++) effInv += j[b] * j[b] * this.invMass[b];
        if (effInv < 1e-12) continue;
        const cDot = j[0] * w[0] + j[1] * w[1] + j[2] * w[2];
        const bias = BAUMGARTE * (c.penetration / dt) * 0.5;
        const lambda = -(cDot + bias) / effInv;
        // 累积冲量（简化：无钳制的法向冲量，摩擦另算）
        for (let b = 0; b < 3; b++) w[b] += this.invMass[b] * j[b] * lambda;

        // 库仑摩擦：切向冲量。切向雅可比由接触点切向速度数值求出。
        if (P.dynamics.frictionMu > 0) {
          const tangent = v(-c.normal.y, c.normal.x);
          const jt = this.tangentJacobian(c, tangent);
          let effT = 0;
          for (let b = 0; b < 3; b++) effT += jt[b] * jt[b] * this.invMass[b];
          if (effT < 1e-12) continue;
          const tDot = jt[0] * w[0] + jt[1] * w[1] + jt[2] * w[2];
          let lambdaT = -tDot / effT;
          const maxFric = P.dynamics.frictionMu * Math.abs(lambda);
          lambdaT = clamp(lambdaT, -maxFric, maxFric);
          for (let b = 0; b < 3; b++) w[b] += this.invMass[b] * jt[b] * lambdaT;
        }
      }
    }

    // 3) 位置积分（qWheel 顺时针为正）
    this.q = {
      qWheel: this.q.qWheel + w[0] * dt,
      qPallet: this.q.qPallet + w[1] * dt,
      qBalance: this.q.qBalance + w[2] * dt,
    };
    this.w = { wWheel: w[0], wPallet: w[1], wBalance: w[2] };

    // 4) 能量：摆轮游丝势能变化
    const dq = w[2] * dt;
    const dE = P.balance.springStiffness * this.q.qBalance * dq;
    this.energyToBalance += dE;

    // 5) 卡滞检测：轮受驱但角速度近零且存在穿透接触
    const jammed =
      Math.abs(w[0]) < 1e-6 &&
      P.dynamics.wheelTorque > 0 &&
      contacts.some((c) => c.penetration > 0.02);

    const dynContacts: DynamicContact[] = contacts.map((c) => ({
      bodyA: c.bodyA,
      bodyB: c.bodyB,
      point: c.point,
      normal: c.normal,
      normalForce: this.estimateForce(c),
      frictionForce: P.dynamics.frictionMu * this.estimateForce(c),
      label: c.label,
    }));

    return {
      state: { ...this.q },
      velocity: { ...this.w },
      contacts: dynContacts,
      energyToBalance: this.energyToBalance,
      jammed,
    };
  }

  /**
   * 切向雅可比：接触点沿切向的相对速度对各体角速度的导数。
   * 对绕 pivot 转动的刚体 i，接触点 r 处切向速度系数为 (t·(z×r))。
   */
  private tangentJacobian(c: RawContact, tangent: Vec2): [number, number, number] {
    const eng = this.eng;
    const pivots: Vec2[] = [
      v(0, 0),
      v(eng.params.pallet.centerDistance, 0),
      v(eng.params.pallet.centerDistance, eng.params.fork.balanceDistance),
    ];
    const coeff = (body: number) => {
      const r = sub(c.point, pivots[body]);
      // z×r = (-ry, rx)，与切向点积
      return dot2(tangent, v(-r.y, r.x));
    };
    // 相对切向速度 = v_A − v_B，雅可比按 A 正 B 负组装
    const j: [number, number, number] = [0, 0, 0];
    j[c.bodyA] += coeff(c.bodyA);
    j[c.bodyB] -= coeff(c.bodyB);
    return j;
  }

  private estimateForce(c: RawContact): number {
    // 法向力由轮力矩经接触法线的力臂反推：N = τ / |r × n|
    const lever = Math.abs(cross(c.point, c.normal));
    if (lever < 1e-9) return 0;
    return this.params.dynamics.wheelTorque / lever;
  }
}

function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 接触点的世界速度（供渲染受力箭头方向） */
export function pointVelocity(
  body: number,
  point: Vec2,
  pivot: Vec2,
  w: MechVelocity,
): Vec2 {
  const omega = body === 0 ? w.wWheel : body === 1 ? w.wPallet : w.wBalance;
  const r = sub(point, pivot);
  // 刚体转动速度 ω × r（2D：(-ω·ry, ω·rx)）
  return v(-omega * r.y, omega * r.x);
}
