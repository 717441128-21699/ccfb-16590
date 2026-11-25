import { describe, expect, it } from 'vitest';
import {
  BALANCE_STAFF,
  LAYOUT,
  buildScene,
  computeMetrics,
  defaultParams,
  poseAtCycle,
  poseAtPhase,
} from '../src/geom/escapement';
import { segmentContact, v2 } from '../src/geom/math';

describe('textbook Swiss lever geometry', () => {
  const params = defaultParams();
  const m = computeMetrics(params);

  it('reproduces pitch, span, lock, drop and lift data within 0.2°', () => {
    expect(m.pitchDeg).toBeCloseTo(24, 6);
    expect(m.beatAdvanceDeg).toBeCloseTo(12, 6);
    expect(m.palletSpanDeg).toBeCloseTo(60, 6);
    expect(m.lockAngleDeg).toBeCloseTo(2.0, 6);
    expect(m.dropAngleDeg).toBeCloseTo(1.5, 6);
    expect(m.palletLiftDeg).toBeCloseTo(5.5, 6);
    expect(m.toothLiftDeg).toBeCloseTo(3.0, 6);
    expect(m.combinedLiftDeg).toBeCloseTo(8.5, 6);
    expect(m.forkTravelDeg).toBeCloseTo(10.0, 6);
    expect(m.balanceLiftDeg).toBeGreaterThan(51.8);
    expect(m.balanceLiftDeg).toBeLessThan(52.2);
    for (const metric of m.metrics) {
      expect(metric.error, `${metric.label} error ${metric.error}`).toBeLessThanOrEqual(metric.tolerance + 1e-9);
    }
  });

  it('computes positive manufacturing lock depth', () => {
    expect(m.lockDepthMm).toBeGreaterThan(0.05);
    expect(m.lockDepthMm).toBeLessThan(0.09);
  });

  it('keeps center distance and pallet radius on the 30° tangent construction', () => {
    expect(m.centerDistanceMm).toBeCloseTo(LAYOUT.lockRadius / Math.cos(Math.PI / 6), 8);
    expect(m.palletRadiusMm).toBeCloseTo(LAYOUT.lockRadius * Math.tan(Math.PI / 6), 8);
    expect(BALANCE_STAFF.x).toBeGreaterThan(LAYOUT.centerDistance);
  });
});

describe('cycle synchronization and energy', () => {
  const params = defaultParams();

  it('advances exactly one 24° tooth while the balance completes one round trip', () => {
    const start = poseAtCycle(0, params);
    const end = poseAtCycle(0.9999, params);
    expect(start.wheelDeg).toBeCloseTo(0, 3);
    expect(end.wheelDeg).toBeLessThan(-23.9);
    expect(end.wheelDeg).toBeGreaterThan(-24.05);
    expect(end.balanceDeg).toBeCloseTo(start.balanceDeg, 0);
  });

  it('balances escape-wheel work and balance energy per beat', () => {
    const { energy } = computeMetrics(params);
    expect(energy.passed).toBe(true);
    expect(energy.relativeError).toBeLessThan(1e-9);
    expect(energy.wheelWorkMilliJoule).toBeGreaterThan(0);
    expect(energy.balanceEnergyMilliJoule).toBeCloseTo(energy.wheelWorkMilliJoule, 12);
  });

  it('produces finite sliding contacts in release and impulse and an end-of-drop lock', () => {
    const queries: Array<[string, number]> = [
      ['release', 0.5],
      ['impulse', 0.5],
      ['drop', 0.92],
    ];
    for (const [phase, q] of queries) {
      const pose = poseAtPhase(phase as 'release' | 'impulse' | 'drop', q, { beat: 0, params });
      expect(pose.contacts.length).toBeGreaterThan(0);
      for (const c of pose.contacts) {
        expect(Number.isFinite(c.point.x)).toBe(true);
        expect(Math.hypot(c.normal.x, c.normal.y)).toBeCloseTo(1, 5);
        expect(c.forceN).toBeGreaterThan(0);
      }
    }
  });

  it('builds fifteen escape teeth into the WebGPU scene', () => {
    const pose = poseAtPhase('impulse', 0.5, { beat: 0, params });
    const scene = buildScene(params, { pose });
    expect(scene.filter((p) => p.id.startsWith('wheel-tooth-')).length).toBe(15);
    expect(scene.some((p) => p.part === 'balance')).toBe(true);
    expect(scene.some((p) => p.part === 'spring')).toBe(true);
  });
});

describe('parameter faults', () => {
  it('flags zero or negative lock depth as slip/skip-tooth', () => {
    const shallow = computeMetrics({ ...defaultParams(), lockAngleDeg: 0, palletAngleDeg: 0 });
    expect(shallow.lockDepthMm).toBeCloseTo(0, 8);
    expect(shallow.slip).toBe(true);
    expect(shallow.diagnostics.some((d) => d.code === 'SLIP_SKIP_TOOTH')).toBe(true);

    const negative = computeMetrics({ ...defaultParams(), lockAngleDeg: -0.4, palletAngleDeg: -0.4 });
    expect(negative.lockDepthMm).toBeLessThan(0);
    expect(negative.slip).toBe(true);
  });

  it('detects the deliberately hooked tooth profile as a jam and locates it', () => {
    const jam = computeMetrics({ ...defaultParams(), profileId: 'hook15' });
    expect(jam.jam).toBe(true);
    expect(jam.diagnostics.some((d) => d.level === 'fault' && d.at)).toBe(true);
    const pose = poseAtPhase('release', 0.55, { beat: 0, params: { ...defaultParams(), profileId: 'hook15' } });
    expect(pose.diagnostic?.level).toBe('fault');
    expect(pose.diagnostic?.at).toBeDefined();
  });

  it('changes drop angle with tooth profile', () => {
    const standardMetrics = computeMetrics(defaultParams());
    const standard = standardMetrics.dropAngleDeg;
    const fine = computeMetrics({ ...defaultParams(), profileId: 'fine15' }).dropAngleDeg;
    const broad = computeMetrics({ ...defaultParams(), profileId: 'broad15' }).dropAngleDeg;
    expect(fine).toBeGreaterThan(standard);
    expect(broad).toBeLessThan(standard);

    const deeperPallet = computeMetrics({ ...defaultParams(), lockAngleDeg: 3.2, palletAngleDeg: 3.2 });
    const shallowPallet = computeMetrics({ ...defaultParams(), lockAngleDeg: 0.6, palletAngleDeg: 0.6 });
    expect(deeperPallet.dropAngleDeg).toBeLessThan(standard);
    expect(shallowPallet.dropAngleDeg).toBeGreaterThan(standard);
    expect(deeperPallet.lockDepthMm).toBeGreaterThan(standardMetrics.lockDepthMm);
  });
});

describe('reference contact kernel', () => {
  it('finds exact segment intersections and face normals', () => {
    const c = segmentContact({ a: v2(-1, 0), b: v2(1, 0) }, { a: v2(0, -1), b: v2(0, 1) });
    expect(c.intersects).toBe(true);
    expect(c.p.x).toBeCloseTo(0);
    expect(c.p.y).toBeCloseTo(0);
    expect(Math.abs(c.normal.x)).toBeCloseTo(1);
  });
});
