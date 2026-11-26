/**
 * 标定/敏感度脚本：扫描叉瓦与轮齿参数，观察锁接深度、落下角、提升角变化。
 * 运行：npm run tune
 */
import { defaultParams, toothFormPresets } from '../src/core/defaults';
import { makeEngine, analyzeBeat } from '../src/core/escapement';

function row(name: string, p: ReturnType<typeof defaultParams>) {
  const a = analyzeBeat(makeEngine(p)).analysis;
  console.log(
    name.padEnd(16),
    '锁深', fmt(a.lockDepthDeg),
    ' 落下', fmt(a.dropAngleDeg),
    ' 叉升', fmt(a.palletLiftDeg),
    ' 摆升', fmt(a.balanceLiftDeg),
    ' 总轮角', fmt(a.wheelAdvancePerBeatDeg),
    ' 跳齿', a.skips,
  );
}

console.log('=== 齿形预设 ===');
for (const [name, patch] of Object.entries(toothFormPresets())) {
  const p = structuredClone(defaultParams());
  Object.assign(p.wheel, patch);
  row(name, p);
}

console.log('\n=== stoneReach 敏感度（锁深）===');
for (const reach of [2.76, 2.79, 2.81, 2.83, 2.86]) {
  const p = structuredClone(defaultParams());
  p.pallet.stoneReach = reach;
  row(`reach=${reach}`, p);
}

console.log('\n=== stoneImpulseAngleDeg 敏感度（叉瓦角）===');
for (const sg of [11, 12.5, 14, 15.5, 17]) {
  const p = structuredClone(defaultParams());
  p.pallet.stoneImpulseAngleDeg = sg;
  row(`sigma=${sg}`, p);
}

function fmt(x: number) {
  return Number.isFinite(x) ? x.toFixed(2).padStart(6) : '   NaN';
}
