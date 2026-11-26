import { defaultParams, toothFormPresets } from '../src/core/defaults';
import { makeEngine, analyzeBeat } from '../src/core/escapement';
import { deg } from '../src/core/math2d';

const p = defaultParams();
const eng = makeEngine(p);
console.log('=== 几何检查 ===');
console.log('轮齿数:', eng.geo.wheel.teeth.length);
const t0 = eng.geo.wheel.teeth[0];
console.log('齿0 profile:', JSON.stringify(t0.profile, null, 0));
console.log('叉瓦数:', eng.geo.stones.length);
for (const s of eng.geo.stones) {
  console.log(
    `  ${s.side === 1 ? '进瓦' : '出瓦'} 放电角=(${s.discharge.x.toFixed(3)},${s.discharge.y.toFixed(3)}) 锁面长=${Math.hypot(s.lockSeg.b.x - s.lockSeg.a.x, s.lockSeg.b.y - s.lockSeg.a.y).toFixed(3)}`,
  );
}
console.log('冲击钉静止中心:', eng.geo.balance.pinRestCenter);
console.log('摆轴:', { x: p.pallet.centerDistance, y: p.fork.balanceDistance });

console.log('\n=== 一拍分析（club） ===');
const r = analyzeBeat(eng);
const a = r.analysis;
console.log('ok:', a.ok, ' skips:', a.skips, ' jammed:', a.jammed?.reason ?? '无');
console.log('锁接深度:', fmt(a.lockDepthDeg), '° (教材 1.0~1.5)');
console.log('落下角:  ', fmt(a.dropAngleDeg), '° (教材 1.0~2.0)');
console.log('叉提升角:', fmt(a.palletLiftDeg), '° (教材 ~5.3)');
console.log('摆提升角:', fmt(a.balanceLiftDeg), '° (教材 8~10)');
console.log('轮传冲角:', fmt(a.wheelImpulseDeg), '°');
console.log('一拍轮转角:', fmt(a.wheelAdvancePerBeatDeg), '° (理论 12)');
console.log('压力角:  ', fmt(a.pressureAngleDeg), '°');
console.log('轨迹点数:', r.track.length);
console.log('warnings:', a.warnings);
console.log('events:');
for (const e of a.events) console.log('  ', e.phase, '|', e.note);

console.log('\n=== 齿形对比 ===');
const presets = toothFormPresets();
for (const [name, patch] of Object.entries(presets)) {
  const pp = structuredClone(defaultParams());
  Object.assign(pp.wheel, patch);
  const ee = makeEngine(pp);
  const rr = analyzeBeat(ee).analysis;
  console.log(
    name.padEnd(10),
    '锁深', fmt(rr.lockDepthDeg),
    '落下', fmt(rr.dropAngleDeg),
    '叉升', fmt(rr.palletLiftDeg),
    '跳齿', rr.skips,
    '卡', rr.jammed ? rr.jammed.reason : '-',
  );
}

function fmt(x: number) {
  return Number.isFinite(x) ? x.toFixed(3) : 'NaN';
}
void deg;
