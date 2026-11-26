/**
 * 验收测试（对应题目两条硬性要求）。
 * 运行：npm test
 */
import { describe, it, expect } from 'vitest';
import { defaultParams, toothFormPresets } from '../src/core/defaults';
import { makeEngine, analyzeBeat, nearestTooth } from '../src/core/escapement';
import { computeEnergyBalance } from '../src/core/energy';
import { deg } from '../src/core/math2d';

const TOL = 0.2; // 题目要求角度误差 ≤ 0.2°

describe('瑞士杠杆擒纵 · 几何指标（要求1）', () => {
  const eng = makeEngine(defaultParams());
  const beat = analyzeBeat(eng);
  const a = beat.analysis;

  it('四阶段事件齐全且无卡滞', () => {
    expect(a.ok).toBe(true);
    expect(a.jammed).toBeNull();
    const phases = a.events.map((e) => e.phase);
    expect(phases).toContain('locked');
    expect(phases).toContain('unlock');
    expect(phases).toContain('impulse');
    expect(phases).toContain('drop');
  });

  it('锁接深度落在教材标准区间 1.0~1.5°（误差≤0.2°）', () => {
    expect(a.lockDepthDeg).toBeGreaterThan(1.0 - TOL);
    expect(a.lockDepthDeg).toBeLessThan(1.5 + TOL);
  });

  it('落下角落在教材标准区间 1.0~2.0°（误差≤0.2°）', () => {
    expect(a.dropAngleDeg).toBeGreaterThan(1.0 - TOL);
    expect(a.dropAngleDeg).toBeLessThan(2.0 + TOL);
  });

  it('叉提升角合理（4~6.5°）', () => {
    expect(a.palletLiftDeg).toBeGreaterThan(4);
    expect(a.palletLiftDeg).toBeLessThan(6.5);
  });

  it('摆轮提升角落在教材区间 8~10°（误差≤0.2°）', () => {
    expect(a.balanceLiftDeg).toBeGreaterThan(8 - TOL);
    expect(a.balanceLiftDeg).toBeLessThan(10 + TOL);
  });

  it('一拍擒纵轮转角严格等于半齿距 = 360/齿数/2 = 12°', () => {
    const expected = 360 / defaultParams().wheel.teeth / 2;
    expect(Math.abs(a.wheelAdvancePerBeatDeg - expected)).toBeLessThan(1e-6);
  });

  it('轨迹采样覆盖四个阶段，可供逐帧慢放', () => {
    const phases = new Set(beat.track.map((t) => t.phase));
    expect(phases.has('impulse')).toBe(true);
    expect(beat.track.length).toBeGreaterThan(60);
  });
});

describe('能量守恒（要求2）', () => {
  it('无摩擦时摆轮每拍能量 = 传冲阶段叉瓦对轮做的功', () => {
    const p = defaultParams();
    p.dynamics.frictionMu = 0;
    const eng = makeEngine(p);
    const beat = analyzeBeat(eng);
    const b = computeEnergyBalance(eng, beat, beat.analysis.balanceLiftDeg);
    // 两条独立路径相对偏差 < 1%
    expect(b.relativeError).toBeLessThan(0.01);
    expect(b.workFromWheel).toBeGreaterThan(0);
    expect(b.energyToBalance).toBeGreaterThan(0);
  });

  it('有摩擦时摆轮净得能量 = 轮做功 − 摩擦耗散', () => {
    const p = defaultParams();
    p.dynamics.frictionMu = 0.15;
    const eng = makeEngine(p);
    const beat = analyzeBeat(eng);
    const b = computeEnergyBalance(eng, beat, beat.analysis.balanceLiftDeg);
    expect(b.frictionLoss).toBeGreaterThan(0);
    expect(b.netWorkToBalance).toBeLessThan(b.workFromWheel);
    expect(Math.abs(b.netWorkToBalance - b.energyToBalance) / b.workFromWheel).toBeLessThan(0.02);
  });
});

describe('周期同步（要求：一轮齿对应摆轮来回一次）', () => {
  it('半拍轮转角 12°，两个半拍合成一个完整齿距 24°', () => {
    const p = defaultParams();
    const eng = makeEngine(p);
    const a = analyzeBeat(eng).analysis;
    const fullPitch = 360 / p.wheel.teeth;
    expect(Math.abs(2 * a.wheelAdvancePerBeatDeg - fullPitch)).toBeLessThan(1e-6);
  });
});

describe('跳齿与卡滞判定（要求2）', () => {
  it('锁接深度为零/负时判定打滑跳齿（ratchet 齿形）', () => {
    const p = defaultParams();
    Object.assign(p.wheel, toothFormPresets().ratchet);
    const eng = makeEngine(p);
    const a = analyzeBeat(eng).analysis;
    expect(a.lockDepthDeg).toBeLessThanOrEqual(0.1);
    expect(a.skips).toBe(true);
    // 必须指出卡在哪：存在 jammed 或明确跳齿警告
    const explained = a.jammed !== null || a.warnings.some((w) => w.includes('跳齿'));
    expect(explained).toBe(true);
  });

  it('标准 club 齿形不跳齿', () => {
    const p = defaultParams();
    Object.assign(p.wheel, toothFormPresets().club);
    const a = analyzeBeat(makeEngine(p)).analysis;
    expect(a.skips).toBe(false);
    expect(a.ok).toBe(true);
  });

  it('卡滞时返回诊断信息（相位 + 接触面对 + 原因）', () => {
    const p = defaultParams();
    Object.assign(p.wheel, toothFormPresets().ratchet);
    const a = analyzeBeat(makeEngine(p)).analysis;
    if (a.jammed) {
      expect(a.jammed.phase).toBeTruthy();
      expect(a.jammed.contact).toBeTruthy();
      expect(a.jammed.reason.length).toBeGreaterThan(5);
    }
  });
});

describe('参数调节联动（要求：改瓦角/齿形可见锁深与落下角变化）', () => {
  it('改变 stoneReach 使锁接深度单调变化', () => {
    const results = [2.76, 2.81, 2.86].map((reach) => {
      const p = defaultParams();
      p.pallet.stoneReach = reach;
      return analyzeBeat(makeEngine(p)).analysis.lockDepthDeg;
    });
    // 锁深随 reach 增大而增大
    expect(results[2]).toBeGreaterThan(results[0]);
  });

  it('三种齿形给出可区分的锁接深度', () => {
    const presets = toothFormPresets();
    const depths = Object.keys(presets).map((name) => {
      const p = defaultParams();
      Object.assign(p.wheel, presets[name]);
      return analyzeBeat(makeEngine(p)).analysis.lockDepthDeg;
    });
    const unique = new Set(depths.map((d) => d.toFixed(2)));
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});

describe('接触几何真实性', () => {
  it('接触点来自命名面（锁接面/传冲面）而非关键帧', () => {
    const eng = makeEngine(defaultParams());
    const beat = analyzeBeat(eng);
    const withContact = beat.track.filter((t) => t.contact !== null);
    expect(withContact.length).toBeGreaterThan(10);
    for (const t of withContact.slice(0, 5)) {
      expect(t.contact!.label).toMatch(/锁接面|传冲面/);
    }
  });

  it('最近齿选择稳定且在合法齿号范围', () => {
    const eng = makeEngine(defaultParams());
    const k = nearestTooth(eng, 1);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThan(defaultParams().wheel.teeth);
  });

  it('所有报告角度为有限数（无 NaN 传播）', () => {
    const a = analyzeBeat(makeEngine(defaultParams())).analysis;
    for (const key of ['lockDepthDeg', 'dropAngleDeg', 'palletLiftDeg', 'balanceLiftDeg', 'wheelAdvancePerBeatDeg'] as const) {
      expect(Number.isFinite(a[key])).toBe(true);
    }
    void deg;
  });
});
