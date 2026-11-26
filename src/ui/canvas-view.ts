/**
 * 3D 画布视图：承载 WebGPU 渲染器、动画循环、轨道相机与受力箭头叠加。
 * 无 WebGPU 时显示回退提示（接触计算仍由 TS 引擎在侧栏呈现）。
 */
import { store } from './store';
import { EscapementRenderer } from '../gpu/renderer';
import { buildScene } from '../gpu/scene';
import { FACE_ID } from '../gpu/mesh';
import type { DynamicContact } from '../core/types';

export class CanvasView {
  private canvas: HTMLCanvasElement;
  private renderer: EscapementRenderer | null = null;
  private raf = 0;
  private lastT = 0;
  private stepAcc = 0;
  private arrowHost: HTMLDivElement;

  constructor(canvas: HTMLCanvasElement, arrowHost: HTMLDivElement) {
    this.canvas = canvas;
    this.arrowHost = arrowHost;
  }

  async init() {
    try {
      const s = store.state;
      this.renderer = await EscapementRenderer.create(this.canvas, s.engine);
      buildScene(this.renderer, s.params);
      this.bindCamera();
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
      store.subscribe(() => this.onState());
    } catch (err) {
      this.canvas.style.display = 'none';
      const div = document.createElement('div');
      div.className = 'gpu-fallback';
      div.innerHTML = `<strong>当前浏览器/设备未启用 WebGPU。</strong><br>
        接触计算与全部指标仍由 TypeScript 引擎完成并显示在侧栏；<br>
        如需三维渲染，请使用支持 WebGPU 的 Chrome/Edge 113+ 并启用硬件加速。<br>
        <code>${(err as Error).message}</code>`;
      this.canvas.parentElement?.appendChild(div);
    }
  }

  private bindCamera() {
    let dragging = false;
    let x0 = 0;
    let y0 = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      x0 = e.clientX;
      y0 = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !this.renderer) return;
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      x0 = e.clientX;
      y0 = e.clientY;
      this.renderer.camera.azimuth += dx * 0.008;
      this.renderer.camera.elevation = Math.max(0.15, Math.min(1.45, this.renderer.camera.elevation + dy * 0.008));
    });
    this.canvas.addEventListener('pointerup', () => (dragging = false));
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.renderer) return;
      e.preventDefault();
      this.renderer.camera.distance = Math.max(6, Math.min(40, this.renderer.camera.distance * (1 + Math.sign(e.deltaY) * 0.08)));
    }, { passive: false });
  }

  private onState() {
    if (!this.renderer) return;
    const s = store.state;
    this.renderer.sliceEnabled = s.sliceEnabled ? 1 : 0;
    this.renderer.sliceZ = s.sliceZ;
  }

  private loop(t: number) {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.renderer) return;
    const s = store.state;
    const dt = Math.min(0.05, (t - this.lastT) / 1000 || 0.016);
    this.lastT = t;

    if (s.playing) {
      // 时间累积：按慢放倍率决定每秒推进的轨迹帧数，保证不同刷新率下速度一致
      const framesPerSec = 55 * s.speed;
      this.stepAcc += framesPerSec * dt;
      while (this.stepAcc >= 1) {
        store.advanceTrack();
        this.stepAcc -= 1;
      }
    }

    const state = store.currentState();
    const tr = s.beat.track;
    const point = tr[Math.min(s.trackIndex, tr.length - 1)];
    const contacts: DynamicContact[] = s.showForces && point ? [point.contact].filter(Boolean) as DynamicContact[] : [];

    // 高亮当前接触面
    if (point?.contact) {
      this.renderer.highlightFace = faceIdForLabel(point.contact.label);
    } else {
      this.renderer.highlightFace = 0;
    }

    this.renderer.dispatchSim(state, contacts, dt);
    this.renderer.render(state, s.explode);
    this.renderArrows(contacts);
  }

  private renderArrows(contacts: DynamicContact[]) {
    if (!store.state.showForces || contacts.length === 0) {
      this.arrowHost.innerHTML = '';
      return;
    }
    // 受力信息以屏幕标注呈现（3D 箭头投影在完整实现中由额外线框管线绘制）
    this.arrowHost.innerHTML = contacts
      .map((c) => {
        const n = c.normal;
        const ang = (Math.atan2(n.y, n.x) * 180) / Math.PI;
        return `<div class="force-chip" style="--dir:${ang}deg">
          <span class="arrow">➜</span> ${c.label}<br>
          <small>法向力 ${c.normalForce.toFixed(3)} N · 角 ${ang.toFixed(0)}°</small>
        </div>`;
      })
      .join('');
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }
}

function faceIdForLabel(label: string): number {
  if (label.includes('锁接面')) return label.includes('轮齿') ? FACE_ID['wheel-lock'] : FACE_ID['stone-lock'];
  if (label.includes('传冲面')) return label.includes('轮齿') ? FACE_ID['wheel-impulse'] : FACE_ID['stone-impulse'];
  return 0;
}
