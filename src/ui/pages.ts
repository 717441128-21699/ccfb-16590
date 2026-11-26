/**
 * 四个教学页面的面板构建。
 */
import { store } from './store';
import { toothFormPresets } from '../core/defaults';
import { deg } from '../core/math2d';
import { summarizeEnergy } from '../core/energy';
import type { AppState } from './store';

const PHASE_NAME: Record<string, string> = {
  locked: '① 锁接',
  unlock: '② 释放',
  impulse: '③ 传冲',
  drop: '④ 落下',
  free: '自由行程',
};

function el(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
}

function metricCard(label: string, value: string, hint: string, ok?: boolean) {
  return `<div class="metric ${ok === false ? 'bad' : ok ? 'good' : ''}">
    <div class="metric-label">${label}</div>
    <div class="metric-value">${value}</div>
    <div class="metric-hint">${hint}</div>
  </div>`;
}

/** 页面一：擒纵演示 */
export function demoPage(s: AppState): HTMLElement {
  const a = s.beat.analysis;
  const root = el(`<section class="panel">
    <h2>擒纵演示</h2>
    <p class="desc">擒纵轮受发条力矩驱动，被叉瓦周期性锁放。下方为按接触几何实时算出的一拍指标，颜色标注是否落入教材标准区间。</p>
    <div class="metrics">
      ${metricCard('锁接深度', `${f(a.lockDepthDeg)}°`, '教材 1.0–1.5°', inRange(a.lockDepthDeg, 1.0, 1.5))}
      ${metricCard('落下角', `${f(a.dropAngleDeg)}°`, '教材 1.0–2.0°', inRange(a.dropAngleDeg, 1.0, 2.0))}
      ${metricCard('叉提升角', `${f(a.palletLiftDeg)}°`, '约 5.3°')}
      ${metricCard('摆轮提升角', `${f(a.balanceLiftDeg)}°`, '教材 8–10°', inRange(a.balanceLiftDeg, 8, 10))}
      ${metricCard('一拍轮转角', `${f(a.wheelAdvancePerBeatDeg)}°`, '= 360/齿数/2')}
      ${metricCard('压力角', `${f(a.pressureAngleDeg)}°`, '接触面压力方向')}
    </div>
    <div class="event-log">
      <h3>四阶段事件</h3>
      ${a.events.map((e) => `<div class="event"><b>${PHASE_NAME[e.phase] ?? e.phase}</b><span>${e.note}</span></div>`).join('')}
    </div>
    <div class="energy">
      <h3>能量核算（每拍）</h3>
      ${summarizeEnergy(s.energy).map((l) => `<div class="energy-line">${l}</div>`).join('')}
    </div>
    ${s.jamMessage ? `<div class="jam">⚠ ${s.jamMessage}</div>` : '<div class="ok-msg">✓ 机构运行正常，无卡滞、无跳齿</div>'}
  </section>`);
  return root;
}

/** 页面二：分阶段慢放 */
export function slowmoPage(s: AppState): HTMLElement {
  const tr = s.beat.track;
  const phases = Array.from(new Set(tr.map((t) => t.phase)));
  const root = el(`<section class="panel">
    <h2>分阶段逐帧慢放</h2>
    <p class="desc">一拍被拆成锁接、释放、传冲、落下四段，可逐帧拖动观察"谁带着谁转"。接触点所在面在三维视图中高亮，受力方向叠加箭头。</p>
    <div class="phase-chips">
      ${phases.map((ph) => `<button class="chip" data-phase="${ph}">${PHASE_NAME[ph] ?? ph}</button>`).join('')}
    </div>
    <label class="slider-row">慢放速度
      <input type="range" id="speed" min="0.05" max="1" step="0.05" value="${s.speed}">
      <span>${s.speed.toFixed(2)}×</span>
    </label>
    <label class="slider-row">帧位置（共 ${tr.length} 帧）
      <input type="range" id="frame" min="0" max="${Math.max(0, tr.length - 1)}" step="1" value="${s.trackIndex}">
      <span id="frame-label">${s.trackIndex}</span>
    </label>
    <div class="play-row">
      <button id="play">${s.playing ? '暂停' : '播放'}</button>
    </div>
    <div id="frame-info" class="frame-info"></div>
  </section>`);

  root.querySelector<HTMLInputElement>('#speed')!.oninput = (e) =>
    store.setSpeed(Number((e.target as HTMLInputElement).value));
  root.querySelector<HTMLInputElement>('#frame')!.oninput = (e) => {
    store.setPlaying(false);
    store.setTrackIndex(Number((e.target as HTMLInputElement).value));
  };
  root.querySelector<HTMLButtonElement>('#play')!.onclick = () => store.setPlaying(!s.playing);
  root.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
    chip.onclick = () => {
      const ph = chip.dataset.phase!;
      const idx = tr.findIndex((t) => t.phase === ph);
      if (idx >= 0) {
        store.setPlaying(false);
        store.setTrackIndex(idx);
      }
    };
  });

  const update = () => {
    const st = store.state;
    const t = st.beat.track[Math.min(st.trackIndex, st.beat.track.length - 1)];
    const info = root.querySelector('#frame-info')!;
    if (t) {
      info.innerHTML = `<div class="phase-big">${PHASE_NAME[t.phase] ?? t.phase}</div>
        <div>轮角 ${deg(t.state.qWheel).toFixed(2)}° · 叉角 ${deg(t.state.qPallet).toFixed(2)}° · 摆角 ${deg(t.state.qBalance).toFixed(2)}°</div>
        <div>${t.contact ? `接触面：${t.contact.label} · 法向力 ${t.contact.normalForce.toFixed(3)} N` : '当前帧无刚性接触（自由/落下）'}</div>`;
    }
    root.querySelector<HTMLInputElement>('#frame')!.value = String(st.trackIndex);
    root.querySelector('#frame-label')!.textContent = String(st.trackIndex);
  };
  store.subscribe(update);
  update();
  return root;
}

/** 页面三：零件拆解 */
export function explodePage(s: AppState): HTMLElement {
  const root = el(`<section class="panel">
    <h2>零件拆解与剖切</h2>
    <p class="desc">拖动爆炸滑块把擒纵轮、叉瓦、叉体、冲击钉、摆轮沿各自方向分离；剖切可切开棱柱观察叉瓦与轮齿在厚度方向的啮合。</p>
    <label class="slider-row">爆炸拆解
      <input type="range" id="explode" min="0" max="1" step="0.01" value="${s.explode}">
      <span>${s.explode.toFixed(2)}</span>
    </label>
    <label class="check-row"><input type="checkbox" id="slice" ${s.sliceEnabled ? 'checked' : ''}> 启用剖切</label>
    <label class="slider-row">剖切深度 z
      <input type="range" id="slicez" min="-0.3" max="0.3" step="0.01" value="${s.sliceZ}">
      <span>${s.sliceZ.toFixed(2)}</span>
    </label>
    <div class="partlist">
      <h3>零件清单（真实几何尺寸）</h3>
      <ul>
        <li>擒纵轮：${s.params.wheel.teeth} 齿，节圆 R${s.params.wheel.pitchRadius}mm，齿顶圆 R${(s.params.wheel.pitchRadius + s.params.wheel.addendum).toFixed(2)}mm</li>
        <li>叉瓦：进/出瓦半夹角 ${s.params.pallet.stoneHalfAngleDeg}°，传冲角 ${s.params.pallet.stoneImpulseAngleDeg}°，瓦尖半径 ${s.params.pallet.stoneReach}mm</li>
        <li>冲击钉：半径 ${s.params.fork.pinRadius}mm，偏心距 ${s.params.fork.pinRadiusFromBalance}mm</li>
        <li>摆轮：外径 R${s.params.balance.ringRadius}mm，游丝 4 圈阿基米德螺旋</li>
        <li>限位角 ±${s.params.fork.bankingHalfAngleDeg}°</li>
      </ul>
    </div>
  </section>`);
  root.querySelector<HTMLInputElement>('#explode')!.oninput = (e) =>
    store.setExplode(Number((e.target as HTMLInputElement).value));
  root.querySelector<HTMLInputElement>('#slice')!.onchange = (e) =>
    store.setSlice((e.target as HTMLInputElement).checked, store.state.sliceZ);
  root.querySelector<HTMLInputElement>('#slicez')!.oninput = (e) =>
    store.setSlice(store.state.sliceEnabled, Number((e.target as HTMLInputElement).value));
  return root;
}

/** 页面四：参数调节 */
export function paramsPage(s: AppState): HTMLElement {
  const presets = toothFormPresets();
  const root = el(`<section class="panel">
    <h2>参数调节</h2>
    <p class="desc">修改叉瓦角度或擒纵轮齿形，锁接深度、落下角、提升角即时由接触几何重算。锁深变零或负会判定打滑跳齿并指出卡滞位置。</p>
    <div class="form-group">
      <label>擒纵轮齿形</label>
      <div class="seg" id="forms">
        ${Object.keys(presets).map((f) => `<button data-form="${f}" class="${s.params.wheel.form === f ? 'active' : ''}">${formName(f)}</button>`).join('')}
      </div>
    </div>
    ${slider('stoneReach', '叉瓦尖半径 stoneReach', s.params.pallet.stoneReach, 2.6, 3.0, 0.01)}
    ${slider('stoneImpulseAngleDeg', '叉瓦传冲角 σ', s.params.pallet.stoneImpulseAngleDeg, 8, 20, 0.5)}
    ${slider('stoneHalfAngleDeg', '叉瓦半夹角 γ', s.params.pallet.stoneHalfAngleDeg, 10, 17, 0.1)}
    ${slider('impulseFaceBiasDeg', '轮齿传冲面倾角修正', s.params.wheel.impulseFaceBiasDeg, -40, 10, 1)}
    ${slider('bankingHalfAngleDeg', '限位角', s.params.fork.bankingHalfAngleDeg, 4, 9, 0.1)}
    <div class="live-metrics">
      ${metricCard('锁接深度', `${f(s.beat.analysis.lockDepthDeg)}°`, '≤0 即跳齿', s.beat.analysis.lockDepthDeg > 0.05)}
      ${metricCard('落下角', `${f(s.beat.analysis.dropAngleDeg)}°`, '自由转角')}
      ${metricCard('叉提升角', `${f(s.beat.analysis.palletLiftDeg)}°`, '')}
      ${metricCard('摆提升角', `${f(s.beat.analysis.balanceLiftDeg)}°`, '')}
    </div>
    <button id="reset" class="reset">恢复默认参数</button>
  </section>`);

  root.querySelectorAll<HTMLButtonElement>('#forms button').forEach((b) => {
    b.onclick = () => store.setToothForm(b.dataset.form as never);
  });
  root.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => {
    inp.oninput = () => {
      const key = inp.dataset.key!;
      const val = Number(inp.value);
      store.updateParams((p) => {
        const targets = [p.pallet, p.wheel, p.fork] as unknown as Array<Record<string, number>>;
        for (const t of targets) {
          if (key in t) {
            t[key] = val;
            break;
          }
        }
      });
    };
  });
  root.querySelector<HTMLButtonElement>('#reset')!.onclick = () => {
    store.resetParams();
  };
  return root;
}

function slider(key: string, label: string, value: number, min: number, max: number, step: number) {
  return `<label class="slider-row">${label}
    <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    <span>${value}</span></label>`;
}

function formName(f: string) {
  return f === 'club' ? '钩爪齿' : f === 'steepClub' ? '陡钩爪齿' : '棘齿（易跳）';
}

function inRange(x: number, lo: number, hi: number) {
  return Number.isFinite(x) && x >= lo && x <= hi;
}
function f(x: number) {
  return Number.isFinite(x) ? x.toFixed(2) : '—';
}
