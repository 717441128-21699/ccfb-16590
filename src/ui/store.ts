/**
 * 集中式应用状态（响应式极简实现，无第三方依赖）。
 */
import { defaultParams, toothFormPresets } from '../core/defaults';
import type { MechanismParams, WheelToothForm, MechState } from '../core/types';
import { makeEngine, analyzeBeat, type Engine, type BeatResult } from '../core/escapement';
import { computeEnergyBalance, type EnergyBalance } from '../core/energy';

export type PageId = 'demo' | 'slowmo' | 'explode' | 'params';

export interface AppState {
  page: PageId;
  params: MechanismParams;
  engine: Engine;
  beat: BeatResult;
  energy: EnergyBalance;
  /** 播放控制 */
  playing: boolean;
  speed: number; // 慢放倍率（0.05~1）
  trackIndex: number;
  /** 拆解 0~1 */
  explode: number;
  /** 剖切 */
  sliceEnabled: boolean;
  sliceZ: number;
  /** 显示受力箭头 */
  showForces: boolean;
  /** 高亮接触面 id */
  highlightFace: number;
  /** 卡顿诊断消息 */
  jamMessage: string;
}

type Listener = (s: AppState) => void;

function freshEngine(params: MechanismParams) {
  const engine = makeEngine(params);
  const beat = analyzeBeat(engine);
  const energy = computeEnergyBalance(engine, beat, beat.analysis.balanceLiftDeg);
  return { engine, beat, energy };
}

export class Store {
  state: AppState;
  private listeners = new Set<Listener>();

  constructor() {
    const params = defaultParams();
    const { engine, beat, energy } = freshEngine(params);
    this.state = {
      page: 'demo',
      params,
      engine,
      beat,
      energy,
      playing: true,
      speed: 0.25,
      trackIndex: 0,
      explode: 0,
      sliceEnabled: false,
      sliceZ: 0,
      showForces: true,
      highlightFace: 0,
      jamMessage: '',
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  setPage(page: PageId) {
    this.state.page = page;
    this.emit();
  }

  /** 修改参数后重建引擎并重算一拍 */
  updateParams(mutator: (p: MechanismParams) => void) {
    mutator(this.state.params);
    const { engine, beat, energy } = freshEngine(this.state.params);
    this.state.engine = engine;
    this.state.beat = beat;
    this.state.energy = energy;
    this.state.trackIndex = 0;
    this.state.jamMessage = beat.analysis.jammed
      ? `卡滞：${beat.analysis.jammed.phase} 阶段，${beat.analysis.jammed.contact} — ${beat.analysis.jammed.reason}`
      : beat.analysis.skips
        ? `打滑跳齿：${beat.analysis.warnings.join('；')}`
        : '';
    this.emit();
  }

  setToothForm(form: WheelToothForm) {
    this.updateParams((p) => {
      p.wheel.form = form;
      const preset = toothFormPresets()[form];
      if (preset) Object.assign(p.wheel, preset);
    });
  }

  resetParams() {
    this.state.params = defaultParams();
    const { engine, beat, energy } = freshEngine(this.state.params);
    this.state.engine = engine;
    this.state.beat = beat;
    this.state.energy = energy;
    this.state.trackIndex = 0;
    this.state.jamMessage = '';
    this.emit();
  }

  setPlaying(playing: boolean) {
    this.state.playing = playing;
    this.emit();
  }

  setSpeed(speed: number) {
    this.state.speed = speed;
    this.emit();
  }

  setTrackIndex(i: number) {
    this.state.trackIndex = i;
    this.emit();
  }

  setExplode(e: number) {
    this.state.explode = e;
    this.emit();
  }

  setSlice(enabled: boolean, z?: number) {
    this.state.sliceEnabled = enabled;
    if (z !== undefined) this.state.sliceZ = z;
    this.emit();
  }

  setShowForces(v: boolean) {
    this.state.showForces = v;
    this.emit();
  }

  setHighlightFace(id: number) {
    this.state.highlightFace = id;
    this.emit();
  }

  /** 当前轨迹点对应的机构状态 */
  currentState(): MechState {
    const tr = this.state.beat.track;
    if (tr.length === 0) return { qWheel: 0, qPallet: 0, qBalance: 0 };
    const i = Math.min(this.state.trackIndex, tr.length - 1);
    return tr[i].state;
  }

  /** 推进轨迹（演示循环） */
  advanceTrack() {
    const tr = this.state.beat.track;
    if (tr.length === 0) return;
    let i = this.state.trackIndex + 1;
    if (i >= tr.length) i = 0;
    this.state.trackIndex = i;
  }
}

export const store = new Store();
