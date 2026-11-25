import '../styles.css';
import {
  BALANCE_STAFF,
  PIN_RADIUS,
  PALLET_ARBOR,
  buildScene,
  computeMetrics,
  defaultParams,
  poseAtCycle,
  poseAtPhase,
  wheelCornerWorld,
} from '../geom/escapement';
import { degToRad, type Vec3 } from '../geom/math';
import { TOOTH_PROFILES } from '../geom/standards';
import type {
  EscapementMetrics,
  EscapementParams,
  PageId,
  PartId,
  PhaseId,
  PoseState,
} from '../geom/types';
import { ContactCompute } from '../gpu/contactCompute';
import { GpuRenderer, type RenderLine } from '../gpu/renderer';

const PHASES: PhaseId[] = ['lock', 'release', 'impulse', 'drop'];
const PHASE_LABEL: Record<PhaseId, string> = {
  lock: '① 锁接',
  release: '② 释放',
  impulse: '③ 传冲',
  drop: '④ 落下',
};

const PHASE_COPY: Record<PhaseId, { title: string; who: string; body: string }> = {
  lock: {
    title: '锁接：齿尖停在叉瓦锁接面上',
    who: '擒纵轮齿 ⇄ 叉瓦锁接面',
    body: '轮系力矩使齿尖压向红宝石锁接面；12° 牵引角把叉瓦拉向定位面。此阶段轮、叉近似静止，摆轮带着冲击钉在叉口外自由摆动。锁接棱到齿尖的有符号长度就是锁接深度。',
  },
  release: {
    title: '释放：冲击钉拨开擒纵叉',
    who: '摆轮 / 冲击钉 → 叉槽喇叭口 → 擒纵叉',
    body: '摆轮回摆到中心附近，冲击钉进入叉槽并推动叉身。叉瓦绕叉轴转过锁接角，齿尖沿锁接面滑向锁接棱。红点和 GPU 读数给出当前最近接触段与间隙；若锁接深度≤0，此处没有可行接触根。',
  },
  impulse: {
    title: '传冲：轮齿经叉瓦把能量交给摆轮',
    who: '擒纵轮齿 → 叉瓦冲面 → 叉槽 → 冲击钉 / 摆轮',
    body: '锁接棱让开后，擒纵轮齿压上叉瓦冲面。接触点在齿冲面和叉瓦冲面上滑动，法向力对叉轴产生力矩；叉槽再推动圆柱形冲击钉。理想约束下，轮轴力矩所做的功等于摆轮这一拍增加的能量。',
  },
  drop: {
    title: '落下：空转一个落下角后换到另一叉瓦',
    who: '擒纵轮自由落下 → 下一齿撞击另一叉瓦',
    body: '本轮齿离开冲面后不再推叉，擒纵轮按计算出的落下角自由转过，直到下一个齿落在另一侧叉瓦锁接面上。15 齿轮的齿距为24°，完整一来回对应轮转过一个齿。',
  },
};

const PART_INFO: Array<{ id: PartId; name: string; color: string; description: string }> = [
  { id: 'wheel', name: '擒纵轮/轮齿', color: '#c7ad6b', description: '15 齿俱乐部齿，可切换细齿、宽齿和倒钩故障齿形。' },
  { id: 'fork', name: '擒纵叉/叉槽', color: '#9fb3c8', description: '绕叉轴摆动，把叉瓦受到的冲量传到冲击钉。' },
  { id: 'palletEntry', name: '进入叉瓦', color: '#d129eb', description: '红宝石锁接面与冲面；角度和深度由参数页控制。' },
  { id: 'palletExit', name: '退出叉瓦', color: '#d129eb', description: '反向摆动时接管下一个齿，形成滴答交替。' },
  { id: 'pin', name: '冲击钉', color: '#ff1654', description: '固定在圆盘上的红宝石圆柱，在叉槽两侧传递冲量。' },
  { id: 'roller', name: '圆盘', color: '#526173', description: '与摆轮同轴，容纳冲击钉并配合安全销。' },
  { id: 'balance', name: '摆轮', color: '#ebc252', description: '显示轮缘、摆梁和真实尺寸比例；一个完整来回为一个周期。' },
  { id: 'spring', name: '游丝', color: '#8cd2ff', description: '螺旋游丝提供回复力矩，课堂模型用随摆角变形的螺线表示。' },
];

class EscapementApp {
  private root: HTMLElement;
  private renderer: GpuRenderer | null = null;
  private gpu: ContactCompute | null = null;
  private gpuPending = false;
  private lastGpu = 0;
  private gpuSummary = 'WebGPU compute 初始化中…';
  private params: EscapementParams = defaultParams();
  private metrics: EscapementMetrics = computeMetrics(this.params);
  private page: PageId = 'demo';
  private playing = true;
  private speed = 1;
  private cycle = 0.02;
  private phase: PhaseId = 'impulse';
  private phaseQ = 0.42;
  private beat: 0 | 1 = 0;
  private explode = 0.62;
  private autoRotate = false;
  private hidden = new Set<PartId>();
  private lastTime = performance.now();
  private hudAccumulator = 0;
  private fallbackMessage = '';

  constructor(root: HTMLElement) {
    this.root = root;
    this.shell();
    this.bindEvents();
    this.renderLeft();
    this.renderRight();
    this.initGpu();
    requestAnimationFrame(this.loop);
  }

  private shell(): void {
    this.root.innerHTML = `
      <div class="app">
        <header class="topbar">
          <div class="brand">瑞士杠杆擒纵三维教具<small>CONTACT-GEOMETRY · WEBGPU</small></div>
          <nav class="nav">
            <button data-action="page" data-page="demo" class="active">擒纵演示</button>
            <button data-action="page" data-page="phases">分阶段慢放</button>
            <button data-action="page" data-page="explode">零件拆解</button>
            <button data-action="page" data-page="params">参数调节</button>
          </nav>
          <div class="top-status">
            <span class="pill" id="webgpu-pill">WebGPU 启动中</span>
            <span class="pill ${this.metrics.diagnostics.some((d) => d.level === 'fault') ? 'fault' : 'ok'}" id="status-pill">${this.metrics.slip ? '打滑' : this.metrics.jam ? '卡滞' : '几何闭合'}</span>
          </div>
        </header>
        <main class="workspace">
          <aside class="panel left-panel" id="left-panel"></aside>
          <section class="viewport" id="viewport">
            <canvas id="gpu-canvas"></canvas>
            <div class="view-overlay" id="label-layer"></div>
            <div class="hud" id="hud"></div>
            <div class="view-actions">
              <button data-action="toggle-section" id="section-btn">剖切啮合</button>
              <button data-action="reset-view">复位视角</button>
              <button data-action="top-view">俯视</button>
            </div>
            <div class="timeline" id="timeline"></div>
            <div class="gpu-badge" id="gpu-badge">GPU contact: —</div>
          </section>
          <aside class="panel right-panel" id="right-panel"></aside>
        </main>
      </div>`;
    this.renderTimeline();
  }

  private async initGpu(): Promise<void> {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#gpu-canvas')!;
    try {
      this.renderer = await GpuRenderer.create(canvas);
      this.gpu = new ContactCompute(this.renderer.device);
      const pill = this.root.querySelector('#webgpu-pill');
      if (pill) {
        pill.textContent = 'WebGPU render + compute';
        pill.classList.add('ok');
      }
      this.bindPointer(canvas);
    } catch (error) {
      this.fallbackMessage = error instanceof Error && error.message === 'NO_WEBGPU'
        ? '当前浏览器或课堂大屏主机没有启用 WebGPU。请使用最新版 Edge/Chrome，并在硬件加速中开启 WebGPU。几何计算、测试和参数逻辑仍可运行。'
        : `WebGPU 初始化失败：${error instanceof Error ? error.message : String(error)}`;
      const viewport = this.root.querySelector('#viewport');
      if (viewport) {
        const div = document.createElement('div');
        div.className = 'fallback';
        div.innerHTML = `<div class="box"><h2>无法启动 WebGPU 视口</h2><p class="muted">${this.fallbackMessage}</p><p class="muted">可运行 <span class="kbd">npm test</span> 查看几何与能量一致性测试。</p></div>`;
        viewport.appendChild(div);
      }
      const pill = this.root.querySelector('#webgpu-pill');
      if (pill) pill.textContent = 'WebGPU 不可用';
    }
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    let down = false;
    let lx = 0;
    let ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      down = true;
      lx = e.clientX;
      ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!down || !this.renderer) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      this.renderer.yaw += dx * 0.32;
      this.renderer.pitch = Math.max(-8, Math.min(82, this.renderer.pitch + dy * 0.22));
    });
    canvas.addEventListener('pointerup', () => (down = false));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.renderer) return;
      this.renderer.distance = Math.max(10, Math.min(48, this.renderer.distance + e.deltaY * 0.018));
    }, { passive: false });
  }

  private bindEvents(): void {
    this.root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'page') this.setPage(button.dataset.page as PageId);
      if (action === 'play') this.playing = !this.playing;
      if (action === 'reset-view' && this.renderer) {
        this.renderer.yaw = -34; this.renderer.pitch = 38; this.renderer.distance = 28.5;
      }
      if (action === 'top-view' && this.renderer) {
        this.renderer.yaw = 0; this.renderer.pitch = 82; this.renderer.distance = 22;
      }
      if (action === 'toggle-section') {
        this.params.sectionCut = !this.params.sectionCut;
        this.syncSectionButton();
        this.renderLeft();
      }
      if (action === 'phase') {
        this.phase = button.dataset.phase as PhaseId;
        if (this.page === 'demo') this.setPage('phases');
      }
      if (action === 'beat') this.beat = Number(button.dataset.beat) as 0 | 1;
      if (action === 'step') {
        const delta = Number(button.dataset.delta);
        this.phaseQ = Math.max(0, Math.min(1, this.phaseQ + delta));
      }
      if (action === 'part') this.togglePart(button.dataset.part as PartId);
      if (action === 'preset') this.applyPreset(button.dataset.preset!);
      if (action === 'reset-params') this.params = defaultParams();
      this.updateActiveButtons();
    });

    this.root.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      const key = target.dataset.param as keyof EscapementParams | undefined;
      if (target.type === 'range' || target.type === 'number') {
        const value = Number(target.value);
        if (key) (this.params as unknown as Record<string, unknown>)[key] = value;
        if (target.dataset.bound === 'cycle') this.cycle = value;
        if (target.dataset.bound === 'phase') this.phaseQ = value;
        if (target.dataset.bound === 'explode') this.explode = value;
        if (target.dataset.bound === 'speed') this.speed = value;
      } else if (target.type === 'checkbox') {
        if (key) (this.params as unknown as Record<string, unknown>)[key] = target.checked;
        if (target.dataset.bound === 'autorotate') this.autoRotate = target.checked;
      } else if (target.tagName === 'SELECT' && key) {
        (this.params as unknown as Record<string, unknown>)[key] = target.value;
      }
      this.metrics = computeMetrics(this.params);
      this.updateStatusPill();
      this.renderRight();
      if (key === 'sectionCut') this.syncSectionButton();
    });
  }

  private syncSectionButton(): void {
    const btn = this.root.querySelector('#section-btn');
    btn?.classList.toggle('active', this.params.sectionCut);
  }

  private updateActiveButtons(): void {
    this.root.querySelectorAll('[data-page]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.page === this.page));
    this.root.querySelectorAll('[data-phase]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.phase === this.phase));
    this.root.querySelectorAll('[data-beat]').forEach((b) => b.classList.toggle('active', Number((b as HTMLElement).dataset.beat) === this.beat));
    this.root.querySelectorAll('[data-action="play"]').forEach((b) => {
      b.textContent = this.playing ? (b.classList.contains('icon-btn') ? '⏸' : '⏸ 暂停') : (b.classList.contains('icon-btn') ? '▶' : '▶ 播放');
      b.classList.toggle('active', this.playing && !b.classList.contains('icon-btn'));
    });
  }

  private setPage(page: PageId): void {
    this.page = page;
    if (page === 'explode') {
      this.explode = Math.max(this.explode, 0.55);
      if (this.renderer) this.renderer.distance = 32.5;
    } else if (this.renderer) {
      this.renderer.distance = 28.5;
    }
    this.renderLeft();
    this.renderRight();
    this.renderTimeline();
    this.updateActiveButtons();
  }

  private applyPreset(name: string): void {
    const viewSettings = {
      sectionCut: this.params.sectionCut,
      showForces: this.params.showForces,
      showContacts: this.params.showContacts,
    };
    const base = { ...defaultParams(), ...viewSettings };
    if (name === 'standard') this.params = base;
    if (name === 'shallow') this.params = { ...base, lockAngleDeg: 0.45, palletAngleDeg: 0.45 };
    if (name === 'slip') this.params = { ...base, lockAngleDeg: -0.35, palletAngleDeg: -0.35 };
    if (name === 'deep') this.params = { ...base, lockAngleDeg: 3.6, palletAngleDeg: 3.6 };
    if (name === 'jam') this.params = { ...base, profileId: 'hook15', lockAngleDeg: 2.2 };
    this.metrics = computeMetrics(this.params);
    this.renderLeft();
    this.renderRight();
    this.updateStatusPill();
  }

  private togglePart(id: PartId): void {
    if (this.hidden.has(id)) this.hidden.delete(id);
    else this.hidden.add(id);
    this.renderLeft();
  }

  private updateStatusPill(): void {
    const pill = this.root.querySelector('#status-pill');
    if (!pill) return;
    const fault = this.metrics.diagnostics.some((d) => d.level === 'fault');
    pill.className = `pill ${fault ? 'fault' : 'ok'}`;
    pill.textContent = this.metrics.slip ? '打滑/跳齿' : this.metrics.jam ? '几何卡滞' : '几何闭合';
  }

  private renderTimeline(): void {
    const el = this.root.querySelector('#timeline');
    if (!el) return;
    if (this.page === 'explode' || this.page === 'params') {
      el.innerHTML = `<div class="muted">${this.page === 'explode' ? '零件拆解模式：拖动左侧滑杆改变爆炸距离。' : '参数模式：可直接调节左侧几何参数，视口同步剖切与受力箭头。'}</div>`;
      return;
    }
    if (this.page === 'demo') {
      el.innerHTML = `
        <div class="phase-tabs">${PHASES.map((p) => `<button data-action="phase" data-phase="${p}">${PHASE_LABEL[p]}</button>`).join('')}</div>
        <div class="scrub-row">
          <button class="icon-btn" data-action="play" title="播放/暂停">${this.playing ? '⏸' : '▶'}</button>
          <input type="range" min="0" max="0.999" step="0.001" value="${this.cycle}" data-bound="cycle" aria-label="完整周期" />
          <span class="value">一个齿 / 一来回</span>
        </div>`;
      return;
    }
    el.innerHTML = `
      <div class="phase-tabs">${PHASES.map((p) => `<button data-action="phase" data-phase="${p}" class="${p === this.phase ? 'active' : ''}">${PHASE_LABEL[p]}</button>`).join('')}</div>
      <div class="scrub-row">
        <button class="icon-btn" data-action="step" data-delta="-0.025" title="上一帧">◀</button>
        <input type="range" min="0" max="1" step="0.001" value="${this.phaseQ}" data-bound="phase" aria-label="阶段进度" />
        <button class="icon-btn" data-action="step" data-delta="0.025" title="下一帧">▶</button>
      </div>`;
  }

  private renderLeft(): void {
    const el = this.root.querySelector<HTMLElement>('#left-panel');
    if (!el) return;
    if (this.page === 'demo') el.innerHTML = this.demoLeft();
    if (this.page === 'phases') el.innerHTML = this.phasesLeft();
    if (this.page === 'explode') el.innerHTML = this.explodeLeft();
    if (this.page === 'params') el.innerHTML = this.paramsLeft();
    this.updateActiveButtons();
    this.syncSectionButton();
  }

  private demoLeft(): string {
    return `
      <div class="stack">
        <h2>课堂演示</h2>
        <button data-action="play" class="active">${this.playing ? '⏸ 暂停' : '▶ 播放'}</button>
        <label>播放速度 <span class="value">${this.speed.toFixed(2)}×</span>
          <input type="range" min="0.1" max="2" step="0.05" value="${this.speed}" data-bound="speed" />
        </label>
        <label>周期位置（一个齿 / 摆轮一来回）
          <input type="range" min="0" max="0.999" step="0.001" value="${this.cycle}" data-bound="cycle" />
        </label>
        <div class="grid2">
          <label class="part-chip"><input type="checkbox" data-param="showForces" ${this.params.showForces ? 'checked' : ''}/> 受力方向</label>
          <label class="part-chip"><input type="checkbox" data-param="showContacts" ${this.params.showContacts ? 'checked' : ''}/> 接触标记</label>
          <label class="part-chip"><input type="checkbox" data-param="sectionCut" ${this.params.sectionCut ? 'checked' : ''}/> 剖切</label>
        </div>
        <h3>怎么讲</h3>
        <p class="muted">先暂停，用周期滑杆拖到 70% 附近进入传冲；放大叉瓦区域，观察橙色法向力如何从轮齿传到叉瓦，再由叉槽传给红色冲击钉。拖动画面可旋转，滚轮缩放。</p>
        <div class="formula">θ_wheel(完整周期)=24°=360°/15<br/>θ_wheel(每拍)=12°<br/>W_wheel=τ_w Δθ_impulse</div>
      </div>`;
  }

  private phasesLeft(): string {
    const copy = PHASE_COPY[this.phase];
    return `
      <div class="stack">
        <h2>分阶段慢放</h2>
        <div class="grid2">
          <button data-action="beat" data-beat="0" class="${this.beat === 0 ? 'active' : ''}">第 1 拍 · 上叉瓦</button>
          <button data-action="beat" data-beat="1" class="${this.beat === 1 ? 'active' : ''}">第 2 拍 · 下叉瓦</button>
        </div>
        <div class="phase-tabs" style="grid-template-columns:1fr 1fr;">
          ${PHASES.map((p) => `<button data-action="phase" data-phase="${p}" class="${p === this.phase ? 'active' : ''}">${PHASE_LABEL[p]}</button>`).join('')}
        </div>
        <label>逐帧进度 <span class="value">${(this.phaseQ * 100).toFixed(0)}%</span>
          <input type="range" min="0" max="1" step="0.001" value="${this.phaseQ}" data-bound="phase" />
        </label>
        <div class="row">
          <button data-action="step" data-delta="-0.05">⟸ 上几帧</button>
          <button data-action="step" data-delta="0.05">下一帧 ⟹</button>
        </div>
        <h3>${copy.title}</h3>
        <div class="diag"><b>${copy.who}</b>${copy.body}</div>
        <p class="muted">右上角“剖切啮合”会切掉 z&gt;0.62 的前半层，便于从斜侧观察红宝石叉瓦与轮齿；点击“俯视”可看平面接触迹线。</p>
      </div>`;
  }

  private explodeLeft(): string {
    return `
      <div class="stack">
        <h2>零件拆解</h2>
        <label>爆炸距离 <span class="value">${(this.explode * 100).toFixed(0)}%</span>
          <input type="range" min="0" max="1" step="0.01" value="${this.explode}" data-bound="explode" />
        </label>
        <label class="part-chip"><input type="checkbox" data-bound="autorotate" ${this.autoRotate ? 'checked' : ''}/> 自动旋转</label>
        <h3>显示 / 隐藏零件</h3>
        <div class="part-list">
          ${PART_INFO.map((p) => `
            <button class="part-chip ${this.hidden.has(p.id) ? 'off' : ''}" data-action="part" data-part="${p.id}">
              <span class="swatch" style="background:${p.color}"></span>${p.name}
            </button>`).join('')}
        </div>
        <h3>装配关系</h3>
        ${PART_INFO.map((p) => `<p class="muted"><b style="color:${p.color}">${p.name}</b>：${p.description}</p>`).join('')}
      </div>`;
  }

  private paramsLeft(): string {
    return `
      <div class="stack">
        <h2>参数调节 / 故障复现</h2>
        <label>擒纵轮齿形
          <select data-param="profileId">
            ${TOOTH_PROFILES.map((p) => `<option value="${p.id}" ${p.id === this.params.profileId ? 'selected' : ''}>${p.name}</option>`).join('')}
          </select>
        </label>
        <p class="muted">${TOOTH_PROFILES.find((p) => p.id === this.params.profileId)?.description}</p>
        ${this.slider('lockAngleDeg', '叉瓦锁接角（叉瓦角度）', -1, 5, 0.05, '°')}
        ${this.slider('drawAngleDeg', '牵引/工作面倾角', 8, 16, 0.1, '°')}
        ${this.slider('depthOffsetMm', '额外深度偏置', -0.08, 0.16, 0.005, 'mm')}
        ${this.slider('wheelTorqueNmm', '轮轴力矩', 0.005, 0.08, 0.001, 'N·mm')}
        ${this.slider('frictionCoefficient', '摩擦系数（0=理想能量闭合）', 0, 0.25, 0.005, '')}
        <div class="grid2">
          <button data-action="preset" data-preset="standard">标准数据</button>
          <button data-action="preset" data-preset="shallow">浅锁接</button>
          <button class="danger" data-action="preset" data-preset="slip">负深度打滑</button>
          <button class="danger" data-action="preset" data-preset="jam">倒钩卡滞</button>
        </div>
        <button data-action="reset-params">恢复默认参数</button>
        <label class="part-chip"><input type="checkbox" data-param="sectionCut" ${this.params.sectionCut ? 'checked' : ''}/> 打开啮合剖切</label>
      </div>`;
  }

  private slider(key: keyof EscapementParams, label: string, min: number, max: number, step: number, unit: string): string {
    const value = this.params[key] as number;
    return `<label>${label} <span class="value">${value.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1)}${unit}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-param="${key}" /></label>`;
  }

  private renderRight(): void {
    const el = this.root.querySelector<HTMLElement>('#right-panel');
    if (!el) return;
    if (this.page === 'explode') {
      el.innerHTML = `<h2>拆解观察清单</h2>${this.metricCards(false)}<h3>接触 / GPU</h3><div id="gpu-readout">${this.gpuSummary}</div>`;
      return;
    }
    el.innerHTML = `
      <h2>${this.page === 'params' ? '几何计算与教材基准' : '实时几何数据'}</h2>
      ${this.diagnosticCards()}
      ${this.energyCard()}
      <h3>${this.page === 'params' ? '全部标准角度校验' : '关键标准角度'}</h3>
      ${this.metricCards(this.page !== 'params')}
      <h3>WebGPU Compute 接触查询</h3>
      <div id="gpu-readout" class="muted">${this.gpuSummary}</div>`;
  }

  private diagnosticCards(): string {
    return this.metrics.diagnostics
      .map((d) => `<div class="diag ${d.level === 'ok' ? '' : d.level}"><b>${d.level === 'fault' ? '⛔ ' : d.level === 'warn' ? '⚠ ' : '✓ '}${d.title}</b>${d.detail}${d.at ? `<div class="formula" style="margin-top:8px">故障坐标：x=${d.at.x.toFixed(2)} mm, y=${d.at.y.toFixed(2)} mm（红色标记）</div>` : ''}</div>`)
      .join('');
  }

  private energyCard(): string {
    const e = this.metrics.energy;
    return `
      <h3>能量审计（每拍）</h3>
      <div class="energy">
        <div class="e"><div>擒纵轮做功</div><div class="n">${e.wheelWorkMilliJoule.toFixed(5)} mJ</div></div>
        <div class="arrow">→</div>
        <div class="e"><div>摆轮获得</div><div class="n">${e.balanceEnergyMilliJoule.toFixed(5)} mJ</div></div>
      </div>
      <p class="muted">${this.params.frictionCoefficient > 0 ? `摩擦耗散 ${e.frictionWorkMilliJoule.toFixed(6)} mJ；轮功 = 摆轮能量 + 摩擦功。` : '理想无摩擦约束下，两者由同一虚功增量求和，数值误差小于 1e-9。'}</p>
      <div class="formula">relative error = ${(e.relativeError * 100).toExponential(3)}%<br/>audit ${e.passed ? 'PASS' : 'CHECK'}</div>`;
  }

  private metricCards(compact: boolean): string {
    const list = compact ? this.metrics.metrics.slice(0, 6) : this.metrics.metrics;
    return list
      .map((m) => {
        const width = Math.min(100, (Math.min(m.error, m.tolerance * 2) / m.tolerance) * 100);
        return `<div class="metric ${m.pass ? '' : 'fail'}">
          <div class="top"><span class="name">${m.label}</span><span class="badge ${m.pass ? 'pass' : 'fail'}">${m.pass ? '±0.2° PASS' : '偏离'}</span></div>
          <div class="nums">计算 <b>${m.computed.toFixed(3)}${m.unit}</b> · 教材 ${m.standard.toFixed(2)}${m.unit} · 误差 ${m.error.toFixed(3)}${m.unit}</div>
          <div class="bar"><i style="width:${m.pass ? 100 : width}%;${m.pass ? '' : 'background:var(--fault)'}"></i></div>
          ${compact ? '' : `<p class="muted" style="margin:7px 0 0">${m.explanation}</p>`}
        </div>`;
      })
      .join('');
  }

  private loop = (now: number): void => {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (this.playing) {
      if (this.page === 'phases') {
        this.phaseQ += dt * 0.075 * this.speed;
        if (this.phaseQ > 1) {
          this.phaseQ = 0;
          const idx = PHASES.indexOf(this.phase);
          if (idx === PHASES.length - 1) {
            this.phase = 'lock';
            this.beat = ((this.beat + 1) % 2) as 0 | 1;
          } else {
            this.phase = PHASES[idx + 1];
          }
          this.renderTimeline();
          this.updateActiveButtons();
        }
        const slider = this.root.querySelector<HTMLInputElement>('input[data-bound="phase"]');
        if (slider && document.activeElement !== slider) slider.value = String(this.phaseQ);
      } else {
        this.cycle = (this.cycle + (dt * this.speed) / 30) % 1;
        this.root.querySelectorAll<HTMLInputElement>('input[data-bound="cycle"]').forEach((slider) => {
          if (document.activeElement !== slider) slider.value = String(this.cycle);
        });
      }
      if (this.autoRotate && this.renderer) this.renderer.yaw += dt * 8;
    }

    const pose = this.page === 'phases'
      ? poseAtPhase(this.phase, this.phaseQ, { beat: this.beat, params: this.params })
      : poseAtCycle(this.cycle, this.params);
    const explode = this.page === 'explode' ? this.explode : 0;
    let polygons = buildScene(this.params, { pose, explode });
    polygons = polygons.filter((p) => !this.hidden.has(p.part));
    const lines = this.buildOverlayLines(pose, polygons);
    this.renderer?.render(polygons, lines, this.params.sectionCut);
    this.updateLabels(pose, explode);
    this.updateHud(pose, now);
    this.maybeGpuQuery(now, pose);
    requestAnimationFrame(this.loop);
  };

  private buildOverlayLines(pose: PoseState, polygons: ReturnType<typeof buildScene>): RenderLine[] {
    const lines: RenderLine[] = [];
    if (this.params.showContacts) {
      for (const p of polygons) {
        for (const f of p.contactFaces ?? []) {
          lines.push({
            a: { x: f.a.x, y: f.a.y, z: (p.z ?? 0) + 0.34 },
            b: { x: f.b.x, y: f.b.y, z: (p.z ?? 0) + 0.34 },
            color: f.id === 'lock' ? [0.3, 1, 0.72, 1] : [0.35, 0.84, 1, 1],
          });
        }
      }
    }
    if (this.params.showForces) {
      for (const c of pose.contacts) {
        const a: Vec3 = { x: c.point.x, y: c.point.y, z: 0.82 };
        const length = 1.25;
        const n = c.normal;
        const b: Vec3 = { x: a.x + n.x * length, y: a.y + n.y * length, z: a.z };
        lines.push({ a, b, color: [1, 0.28, 0.42, 1] });
        const side = { x: -n.y, y: n.x };
        for (const sign of [-1, 1]) {
          lines.push({
            a: b,
            b: { x: b.x - n.x * 0.34 + side.x * 0.18 * sign, y: b.y - n.y * 0.34 + side.y * 0.18 * sign, z: b.z },
            color: [1, 0.28, 0.42, 1],
          });
        }
      }
    }
    const faultAt = pose.diagnostic?.at ?? this.metrics.diagnostics.find((d) => d.level === 'fault' && d.at)?.at;
    if (faultAt) {
      const z = 1.05;
      const r = 0.34;
      const red: [number, number, number, number] = [1, 0.18, 0.32, 1];
      lines.push({ a: { x: faultAt.x - r, y: faultAt.y - r, z }, b: { x: faultAt.x + r, y: faultAt.y + r, z }, color: red });
      lines.push({ a: { x: faultAt.x - r, y: faultAt.y + r, z }, b: { x: faultAt.x + r, y: faultAt.y - r, z }, color: red });
      for (let i = 0; i < 28; i++) {
        const a0 = (i / 28) * Math.PI * 2;
        const a1 = ((i + 1) / 28) * Math.PI * 2;
        lines.push({
          a: { x: faultAt.x + Math.cos(a0) * 0.24, y: faultAt.y + Math.sin(a0) * 0.24, z },
          b: { x: faultAt.x + Math.cos(a1) * 0.24, y: faultAt.y + Math.sin(a1) * 0.24, z },
          color: red,
        });
      }
    }

    // Fixed center-line construction.
    lines.push({
      a: { x: -1.2, y: 0, z: -0.35 },
      b: { x: BALANCE_STAFF.x + 5.2, y: 0, z: -0.35 },
      color: [0.3, 0.55, 0.75, 0.28],
    });
    return lines;
  }

  private updateLabels(pose: PoseState, explode: number): void {
    const layer = this.root.querySelector<HTMLElement>('#label-layer');
    if (!layer || !this.renderer) return;
    const labels: Array<{ id: string; text: string; p: Vec3; cls?: string }> = [
      { id: 'wheel', text: '擒纵轮 15T', p: { x: -0.4 - explode * 1.4, y: -3.65, z: 0.7 } },
      { id: 'fork', text: '擒纵叉轴', p: { x: PALLET_ARBOR.x + explode * 0.8, y: 0.75 + explode * 0.55, z: 1.5 } },
      { id: 'pallet', text: '红宝石叉瓦', p: { x: PALLET_ARBOR.x - 0.9, y: 2.35 + explode, z: 1.5 } },
      { id: 'pin', text: '冲击钉', p: { x: pose.pin.x + explode * 2.4, y: pose.pin.y + 0.55, z: 1.9 }, cls: 'force' },
      { id: 'balance', text: '摆轮 + 游丝', p: { x: BALANCE_STAFF.x + explode * 4.2, y: 4.65, z: 0.9 } },
    ];
    const existing = new Set<string>();
    for (const label of labels) {
      existing.add(label.id);
      let el = layer.querySelector<HTMLDivElement>(`[data-label="${label.id}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = `label3d ${label.cls ?? ''}`;
        el.dataset.label = label.id;
        layer.appendChild(el);
      }
      el.textContent = label.text;
      const projected = this.renderer.project(label.p.x, label.p.y, label.p.z);
      el.style.left = `${projected.x}px`;
      el.style.top = `${projected.y}px`;
      el.style.display = projected.visible ? 'block' : 'none';
    }
    layer.querySelectorAll('[data-label]').forEach((el) => {
      if (!existing.has((el as HTMLElement).dataset.label!)) el.remove();
    });
  }

  private updateHud(pose: PoseState, now: number): void {
    if (now - this.hudAccumulator < 120) return;
    this.hudAccumulator = now;
    const hud = this.root.querySelector<HTMLElement>('#hud');
    if (!hud) return;
    const copy = PHASE_COPY[pose.phase];
    const fault = pose.diagnostic?.level === 'fault' || this.metrics.diagnostics.some((d) => d.level === 'fault');
    hud.className = `hud ${fault ? 'fault' : ''}`;
    hud.innerHTML = `
      <div class="phase-title">${PHASE_LABEL[pose.phase]} · 拍 ${pose.beat + 1} · ${(pose.phaseProgress * 100).toFixed(0)}%</div>
      <div class="who">${copy.who}</div>
      <p class="muted" style="margin:7px 0 0">${pose.diagnostic?.detail ?? copy.body}</p>
      <div style="display:flex;gap:14px;margin-top:9px;flex-wrap:wrap;font-size:13px">
        <span>轮 <b class="value">${pose.wheelDeg.toFixed(2)}°</b></span>
        <span>叉 <b class="value">${pose.forkDeg.toFixed(2)}°</b></span>
        <span>摆 <b class="value">${pose.balanceDeg.toFixed(1)}°</b></span>
        <span>接触对 <b class="value">${pose.contacts.length}</b></span>
      </div>`;
  }

  private maybeGpuQuery(now: number, pose: PoseState): void {
    if (!this.gpu || !this.renderer || this.gpuPending || now - this.lastGpu < 650 || this.page === 'explode') return;
    this.lastGpu = now;
    this.gpuPending = true;
    const scene = buildScene(this.params, { pose, explode: 0 });
    const faces = scene.flatMap((p) => (p.contactFaces ?? []).map((f, index) => ({ a: f.a, b: f.b, faceId: index })));
    const points = [
      { p: wheelCornerWorld(pose.beat, -pose.wheelDeg), pointId: 0 },
      ...pose.contacts.slice(0, 7).map((c, i) => ({ p: c.point, pointId: i + 1 })),
    ];
    this.gpu.query(points, faces).then((results) => {
      const nearest = results.filter((r) => r.pointId > 0).sort((a, b) => a.distance - b.distance)[0] ?? results[0];
      this.gpuSummary = nearest
        ? `最近接触点 #${nearest.pointId} ↔ 面 #${nearest.faceId}，GPU 距离 ${nearest.distance.toFixed(4)} mm，滑点 t=${nearest.t.toFixed(3)}。Compute shader 每帧对齿角/接触点到叉瓦面做最近段查询。`
        : '未生成接触查询。';
      const badge = this.root.querySelector('#gpu-badge');
      if (badge && nearest) badge.textContent = `GPU contact d=${nearest.distance.toFixed(3)} mm`;
      const readout = this.root.querySelector('#gpu-readout');
      if (readout) readout.innerHTML = this.gpuSummary;
    }).catch((error) => {
      this.gpuSummary = `GPU readback 暂不可用：${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => {
      this.gpuPending = false;
    });
  }
}

export function startApp(root: HTMLElement): EscapementApp {
  return new EscapementApp(root);
}

// Keep degToRad/PIN_RADIUS referenced for API consumers and tree-shaking clarity.
export const geometryDebug = { degToRad, PIN_RADIUS };
