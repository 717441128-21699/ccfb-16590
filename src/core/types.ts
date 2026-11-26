/**
 * 机构参数与状态类型。
 * 所有长度 mm，角度对外用度、内部用弧度。
 */
import type { Vec2 } from './math2d';

/** 擒纵轮齿形 */
export type WheelToothForm = 'club' | 'ratchet' | 'steepClub';

export interface WheelParams {
  teeth: number; // 齿数（标准 15）
  pitchRadius: number; // 节圆半径 Rp
  addendum: number; // 齿顶高 ha => 齿顶圆 Ra=Rp+ha
  dedendum: number; // 齿根高 hd => 齿根圆 Rr=Rp-hd
  rootHalfAngleDeg: number; // 齿根处半角宽
  tipHalfAngleDeg: number; // 齿顶处半角宽
  lockRadius: number; // 锁接面末端所在圆 Rl
  lockHalfAngleDeg: number; // 锁接面末端半角宽
  form: WheelToothForm;
  /** 传冲面倾角修正（度），相对基准传冲面 */
  impulseFaceBiasDeg: number;
}

export interface PalletParams {
  centerDistance: number; // 叉轴 P 到轮轴 O 的距离 L
  stoneReach: number; // 叉瓦尖到叉轴距离
  stoneHalfAngleDeg: number; // 进/出瓦关于连心线的半夹角 γ
  stoneLength: number; // 锁接面长度 ℓ
  stoneThickness: number; // 叉瓦厚度 t
  impulseLength: number; // 传冲面长度 ℓi
  /** 叉瓦传冲角 σ：传冲面与锁接面夹角（度） */
  stoneImpulseAngleDeg: number;
}

export interface ForkParams {
  balanceDistance: number; // 摆轴 B 到叉轴 P 的距离
  slotLength: number; // 叉口槽长
  slotHalfWidth: number; // 叉口槽半宽
  pinRadius: number; // 冲击钉（圆盘钉）半径
  pinRadiusFromBalance: number; // 冲击钉相对摆轴的偏心距
  bankingRadius: number; // 限位钉位置圆
  bankingHalfAngleDeg: number; // 限位角（叉体最大摆角）
}

export interface BalanceParams {
  ringRadius: number; // 摆轮外缘半径（视觉/惯量）
  inertia: number; // 摆轮转动惯量 g·mm²（动力学用）
  springStiffness: number; // 游丝刚度（力矩/弧度）
  amplitudeDeg: number; // 自由摆幅（半幅，度）
}

export interface DynamicsParams {
  wheelTorque: number; // 发条传给擒纵轮的等效力矩 N·mm
  wheelInertia: number;
  palletInertia: number;
  frictionMu: number; // 接触摩擦系数（0=理想无摩擦）
  restitution: number; // 法向恢复系数
}

export interface MechanismParams {
  wheel: WheelParams;
  pallet: PalletParams;
  fork: ForkParams;
  balance: BalanceParams;
  dynamics: DynamicsParams;
}

/** 三个运动体的角位置（rad）。qWheel 沿驱动方向（顺时针）为正 */
export interface MechState {
  qWheel: number;
  qPallet: number;
  qBalance: number;
}

export interface MechVelocity {
  wWheel: number;
  wPallet: number;
  wBalance: number;
}

/** 命名面：几何生成器为每个零件输出带语义标签的边 */
export type FaceLabel =
  | 'wheel-lock'
  | 'wheel-impulse'
  | 'wheel-tip'
  | 'stone-lock'
  | 'stone-impulse'
  | 'stone-discharge'
  | 'fork-wall-entry'
  | 'fork-wall-exit';

export interface LabeledPolygon {
  name: string;
  /** 局部坐标顶点（逆时针） */
  points: Vec2[];
  /** 边 i 连接 points[i] -> points[(i+1)%n]，对应标签（普通边为 null） */
  edgeLabels: Array<FaceLabel | null>;
  /** 所属运动体 */
  body: 'wheel' | 'pallet' | 'balance' | 'fixed';
  /** 该局部几何绕哪个中心旋转 */
  pivot: Vec2;
}

/** 一拍的四个工作阶段 */
export type EscapementPhase =
  | 'locked' // 锁接
  | 'unlock' // 释放（解锁）
  | 'impulse' // 传冲
  | 'drop' // 落下
  | 'free'; // 摆轮自由行程（无接触，供演示用）

export interface PhaseEvent {
  phase: EscapementPhase;
  /** 事件触发时的状态角（rad） */
  state: MechState;
  /** 参与接触的命名面对 */
  contact: string;
  note: string;
}

/** 一拍解析计算结果（角度均为度） */
export interface BeatAnalysis {
  ok: boolean;
  /** 锁接深度：释放所需的轮转角 */
  lockDepthDeg: number;
  /** 落下角：传冲结束到下一齿锁接之间轮的自由转角 */
  dropAngleDeg: number;
  /** 叉提升角：传冲中叉体转过的角度 */
  palletLiftDeg: number;
  /** 摆轮提升角：经冲击钉折算到摆轮的升角 */
  balanceLiftDeg: number;
  /** 传冲阶段轮转角 */
  wheelImpulseDeg: number;
  /** 一拍轮总转角（应=360/齿数/2） */
  wheelAdvancePerBeatDeg: number;
  /** 传冲面间等效压力角 */
  pressureAngleDeg: number;
  /** 打滑跳齿判定 */
  skips: boolean;
  /** 卡滞判定 */
  jammed: JamInfo | null;
  events: PhaseEvent[];
  warnings: string[];
}

export interface JamInfo {
  phase: EscapementPhase;
  contact: string;
  reason: string;
  state: MechState;
}

/** 动力学单步接触信息（供渲染受力箭头/卡顿诊断） */
export interface DynamicContact {
  bodyA: number; // 0 wheel 1 pallet 2 balance
  bodyB: number;
  point: Vec2;
  normal: Vec2; // 由 B 指向 A
  normalForce: number;
  frictionForce: number;
  label: string;
}
