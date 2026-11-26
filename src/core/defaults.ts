/**
 * 默认机构参数（比例参照 Reymondin《Theory of the Swiss Lever Escapement》）。
 * 长度 mm；角度 deg。可在参数调节页修改，事件引擎即时重算。
 */
import type { MechanismParams } from './types';

export function defaultParams(): MechanismParams {
  return {
    wheel: {
      teeth: 15,
      pitchRadius: 2.5,
      addendum: 0.62,
      dedendum: 0.42,
      rootHalfAngleDeg: 4.6,
      tipHalfAngleDeg: 1.7,
      lockRadius: 2.78,
      lockHalfAngleDeg: 3.4,
      form: 'club',
      // 使轮齿传冲面在解锁末与进瓦传冲面近乎平行（平行度>0.99）
      impulseFaceBiasDeg: -30,
    },
    pallet: {
      centerDistance: 5.4,
      // 标定值：锁接深度≈1.25°（教材标准），传冲面在解锁末恰好贴合
      stoneReach: 2.81,
      stoneHalfAngleDeg: 13.5,
      stoneLength: 0.55,
      stoneThickness: 0.34,
      impulseLength: 0.18,
      stoneImpulseAngleDeg: 14,
    },
    fork: {
      balanceDistance: 5.0,
      slotLength: 0.72,
      slotHalfWidth: 0.11,
      pinRadius: 0.075,
      pinRadiusFromBalance: 0.55,
      bankingRadius: 3.4,
      bankingHalfAngleDeg: 5.3,
    },
    balance: {
      ringRadius: 2.6,
      inertia: 220,
      // 游丝刚度标定：无摩擦理想约束下 ½k·θ_lift² = τ_wheel·Δθ_wheel，
      // 使摆轮每拍获得的能量恰好等于传冲阶段叉瓦对轮做的功（要求 2）。
      springStiffness: 8.08,
      amplitudeDeg: 285,
    },
    dynamics: {
      wheelTorque: 0.42,
      wheelInertia: 0.9,
      palletInertia: 0.25,
      frictionMu: 0,
      restitution: 0.15,
    },
  };
}

/** 三种预置齿形（题目要求自行编出的齿形库）。
 *  均基于可啮合的 club 拓扑，通过齿面倾角/齿高差异化，
 *  体现不同的锁深、落下角与传冲特性。 */
export function toothFormPresets(): Record<
  string,
  Partial<MechanismParams['wheel']>
> {
  return {
    // 标准钩爪齿：锁面与传冲面分明，综合性能均衡
    club: {
      form: 'club',
      addendum: 0.62,
      lockRadius: 2.78,
      lockHalfAngleDeg: 3.4,
      tipHalfAngleDeg: 1.7,
      impulseFaceBiasDeg: -30,
    },
    // 陡钩爪齿：传冲面更陡，提升角偏大、锁深偏浅，对振动更敏感
    steepClub: {
      form: 'steepClub',
      addendum: 0.58,
      lockRadius: 2.82,
      lockHalfAngleDeg: 3.0,
      tipHalfAngleDeg: 1.4,
      impulseFaceBiasDeg: -22,
    },
    // 棘齿（直齿）：齿尖尖锐、锁面退化，锁接浅至小负值，稳定演示打滑跳齿
    ratchet: {
      form: 'ratchet',
      addendum: 0.66,
      lockRadius: 2.85,
      lockHalfAngleDeg: 2.2,
      tipHalfAngleDeg: 1.5,
      rootHalfAngleDeg: 5.2,
      impulseFaceBiasDeg: -34,
    },
  };
}
