import type { StandardDatum, ToothProfile, ToothProfileId } from './types';

/**
 * Baseline drafting specification from the Chicago lesson / Practical Lessons
 * lever-escapement course: 15 teeth, 24° pitch, 60° lock-to-lock pallet span,
 * 6° pallet width, 4.5° tooth width, 1.5° drop, 2° total lock (1.5° drop lock
 * + 0.5° slide), 12° draft, 3° lift on tooth and 5.5° lift on pallet.
 * Modern timegraphers conventionally call the balance contact arc 52°.
 */
export const STANDARD: Record<string, StandardDatum> = {
  pitch: { key: 'pitch', label: '擒纵轮齿距角', value: 24, unit: '°', source: '360°/15' },
  beatAdvance: { key: 'beatAdvance', label: '每拍轮角', value: 12, unit: '°', source: '齿距角/2' },
  palletSpan: { key: 'palletSpan', label: '两叉瓦跨角', value: 60, unit: '°', source: '2.5 个齿距间隔' },
  totalLock: { key: 'totalLock', label: '总锁接角', value: 2.0, unit: '°', source: '教材制图规范' },
  dropLock: { key: 'dropLock', label: '落下锁接角', value: 1.5, unit: '°', source: '1½° drop lock' },
  slide: { key: 'slide', label: '滑动锁接角', value: 0.5, unit: '°', source: '½° slide' },
  drop: { key: 'drop', label: '落下角', value: 1.5, unit: '°', source: '12°−6°−4.5°' },
  palletLift: { key: 'palletLift', label: '叉瓦提升角', value: 5.5, unit: '°', source: '5½° lift on pallet' },
  toothLift: { key: 'toothLift', label: '齿提升角', value: 3.0, unit: '°', source: '3° lift on tooth' },
  combinedLift: { key: 'combinedLift', label: '传冲总提升角', value: 8.5, unit: '°', source: '3°+5.5°' },
  forkTravel: { key: 'forkTravel', label: '擒纵叉全摆角', value: 10.0, unit: '°', source: '1.5°+3°+5.5°' },
  balanceLift: { key: 'balanceLift', label: '摆轮提升角', value: 52.0, unit: '°', source: '现代瑞士机芯常用值' },
  draw: { key: 'draw', label: '牵引角', value: 12.0, unit: '°', source: 'draft/draw angle' },
};

export const TOOTH_PROFILES: ToothProfile[] = [
  {
    id: 'club15',
    name: '现代俱乐部齿（教材基准）',
    description: '15 齿，4.5° 齿宽，3° 提升斜面，24° 齿背斜角；与教材标准数据校准。',
    teeth: 15,
    toothWidthDeg: 4.5,
    toothLiftDeg: 3.0,
    draftDeg: 24,
    rootRadius: 2.72,
    lockRadius: 3.2,
    tipRadius: 3.52,
  },
  {
    id: 'fine15',
    name: '细尖齿',
    description: '较窄齿尖和更长冲面；落下角增大，锁接更浅，适合观察滑冲轨迹。',
    teeth: 15,
    toothWidthDeg: 3.4,
    toothLiftDeg: 4.2,
    draftDeg: 20,
    rootRadius: 2.78,
    lockRadius: 3.24,
    tipRadius: 3.62,
  },
  {
    id: 'broad15',
    name: '宽工作面俱乐部齿',
    description: '加厚齿宽、短冲面；落下角变小，冲击时间更长。',
    teeth: 15,
    toothWidthDeg: 5.4,
    toothLiftDeg: 2.4,
    draftDeg: 27,
    rootRadius: 2.66,
    lockRadius: 3.18,
    tipRadius: 3.46,
  },
  {
    id: 'hook15',
    name: '倒钩干涉齿（故障样本）',
    description: '人为加入 1.1° 倒钩干涉，释放时齿尖与叉瓦冲面相互别住。',
    teeth: 15,
    toothWidthDeg: 4.8,
    toothLiftDeg: 3.4,
    draftDeg: 31,
    rootRadius: 2.62,
    lockRadius: 3.2,
    tipRadius: 3.5,
    interferenceDeg: 1.1,
  },
];

export function getProfile(id: ToothProfileId): ToothProfile {
  return TOOTH_PROFILES.find((p) => p.id === id) ?? TOOTH_PROFILES[0];
}
