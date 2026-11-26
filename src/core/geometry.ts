/**
 * 参数化几何生成器。
 *
 * 坐标系（俯视机构平面，z 轴为挤出方向）：
 *   轮轴 O = (0,0)；叉轴 P = (L,0) 在轮右侧；摆轴 B = (L,dB) 在叉轴上方。
 *   qWheel 顺时针为正；qPallet / qBalance 逆时针为正（数学约定）。
 *
 * 每个运动体输出若干凸块 LabeledPolygon（SAT 需要凸包），
 * 边带语义标签（锁接面/传冲面/叉口壁…），接触引擎据此报告"谁在哪个面上滑"。
 */
import {
  Vec2,
  v,
  add,
  sub,
  scale,
  rot,
  norm,
  dot,
  fromPolar,
  polygonArea,
  type Segment,
} from './math2d';
import type {
  MechanismParams,
  LabeledPolygon,
  FaceLabel,
  WheelToothForm,
} from './types';

export const PIVOT_WHEEL: Vec2 = v(0, 0);

export function palletPivot(p: MechanismParams): Vec2 {
  return v(p.pallet.centerDistance, 0);
}
export function balancePivot(p: MechanismParams): Vec2 {
  return v(p.pallet.centerDistance, p.fork.balanceDistance);
}

/** 轮齿单侧（低角侧=顺时针前进侧）关键极坐标点 */
interface ToothProfile {
  root: Vec2; // 齿根前进侧
  lock: Vec2; // 锁接面末端（club 齿有；ratchet 与 tip 重合）
  tipLead: Vec2; // 齿顶前进侧角
  tipTrail: Vec2; // 齿顶后侧角
  back: Vec2; // 齿根后侧
}

function polarPoint(r: number, ang: number): Vec2 {
  return fromPolar(r, ang);
}

function toothPoints(
  center: number,
  wp: MechanismParams['wheel'],
): ToothProfile {
  const rootHalf = (wp.rootHalfAngleDeg * Math.PI) / 180;
  const tipHalf = (wp.tipHalfAngleDeg * Math.PI) / 180;
  const lockHalf = (wp.lockHalfAngleDeg * Math.PI) / 180;
  const Ra = wp.pitchRadius + wp.addendum;
  const Rr = wp.pitchRadius - wp.dedendum;
  const Rl = wp.lockRadius;
  const root = polarPoint(Rr, center - rootHalf);
  const tipLead = polarPoint(Ra, center - tipHalf);
  const tipTrail = polarPoint(Ra, center + tipHalf);
  const back = polarPoint(Rr, center + rootHalf);
  // 三种齿形都保留独立锁面端点，维持统一的啮合拓扑；
  // ratchet 的锁点更靠近齿尖（锁面短、锁接浅），体现直齿特性。
  const lock = polarPoint(Rl, center - lockHalf);
  return { root, lock, tipLead, tipTrail, back };
}

/**
 * 擒纵轮整体轮廓（逆时针）。轮体本身非凸，按边做线段级接触；
 * 另为每个齿输出一个凸包 toothHulls[i] 供 SAT/渲染高亮。
 */
export interface WheelGeometry {
  outline: LabeledPolygon;
  teeth: Array<{
    centerAngle: number;
    profile: ToothProfile;
    hull: LabeledPolygon;
    lockSeg: Segment;
    impulseSeg: Segment;
  }>;
}

export function buildWheel(p: MechanismParams): WheelGeometry {
  const wp = p.wheel;
  const n = wp.teeth;
  const pitch = (2 * Math.PI) / n;
  const pts: Vec2[] = [];
  const labels: Array<FaceLabel | null> = [];
  const teeth: WheelGeometry['teeth'] = [];

  for (let i = 0; i < n; i++) {
    const c = i * pitch;
    const tp = toothPoints(c, wp);
    // 传冲面倾角修正：围绕 lock 点旋转 lock->tipLead 段（所有齿形统一）
    let lead = tp.tipLead;
    if (wp.impulseFaceBiasDeg !== 0) {
      const b = (wp.impulseFaceBiasDeg * Math.PI) / 180;
      lead = add(tp.lock, rot(sub(tp.tipLead, tp.lock), b));
    }
    // 逆时针顺序：root -> lock -> tipLead -> tipTrail -> back
    pts.push(tp.root, tp.lock, lead, tp.tipTrail, tp.back);
    const lockSeg: Segment = { a: tp.root, b: tp.lock };
    const impulseSeg: Segment = { a: tp.lock, b: lead };
    const e: Array<FaceLabel | null> = [
      'wheel-lock',
      'wheel-impulse',
      'wheel-tip',
      null,
      null,
    ];
    for (const lab of e) labels.push(lab);
    // 齿根圆弧中点
    const midAng = c + ((wp.rootHalfAngleDeg * Math.PI) / 180);
    pts.push(polarPoint(wp.pitchRadius - wp.dedendum, midAng));
    labels.push(null);
    const hullPts = [tp.root, tp.lock, lead, tp.tipTrail, tp.back];
    teeth.push({
      centerAngle: c,
      profile: { ...tp, tipLead: lead },
      hull: ensureCCW({
        name: `wheel-tooth-${i}`,
        points: hullPts,
        edgeLabels: ['wheel-lock', 'wheel-impulse', 'wheel-tip', null, null],
        body: 'wheel',
        pivot: PIVOT_WHEEL,
      }),
      lockSeg,
      impulseSeg,
    });
  }
  const outline = ensureCCW({
    name: 'wheel-outline',
    points: pts,
    edgeLabels: labels,
    body: 'wheel',
    pivot: PIVOT_WHEEL,
  });
  return { outline, teeth };
}

/** 叉瓦几何（相对叉轴 P 的局部坐标） */
export interface PalletStoneGeometry {
  polygon: LabeledPolygon;
  side: 1 | -1; // +1 进瓦（上），-1 出瓦（下）
  radialAngle: number;
  discharge: Vec2; // 放电角 D（锁接面与传冲面交点）
  lockSeg: Segment;
  impulseSeg: Segment;
}

export function buildStones(p: MechanismParams): PalletStoneGeometry[] {
  const pp = p.pallet;
  const gamma = (pp.stoneHalfAngleDeg * Math.PI) / 180;
  const sigma = (pp.stoneImpulseAngleDeg * Math.PI) / 180;
  const out: PalletStoneGeometry[] = [];
  for (const side of [1, -1] as const) {
    // 进瓦位于连心线上方 α=π-γ；出瓦下方 α=π+γ
    const alpha = Math.PI - side * gamma;
    const er = fromPolar(1, alpha); // 径向（朝外）
    const et = v(-er.y, er.x); // 切向（CCW）
    const toLocal = (r: number, t: number): Vec2 =>
      add(scale(er, r), scale(et, side * t));
    // 放电角 D（瓦尖，锁面与传冲面的公共顶点）
    const D = toLocal(pp.stoneReach, 0);
    // 显式局部角度构造（角度在 r-t 局部基内，side 已吸收进 toLocal）：
    // 锁面从 D 指向瓦内（局部 r 负方向），相对 -r 轴偏转锁面倾角 δL=σ/3。
    const deltaL = sigma / 3;
    const lockLocalAng = Math.PI - deltaL; // 局部极角
    const uL = norm(toLocal(Math.cos(lockLocalAng), Math.sin(lockLocalAng)));
    // 传冲面：与锁面夹 σ，朝向轮齿传冲面一侧（局部角更小、靠 -r 轴下方）。
    const impulseLocalAng = lockLocalAng - sigma;
    const uI = norm(toLocal(Math.cos(impulseLocalAng), Math.sin(impulseLocalAng)));
    const C = add(D, scale(uL, pp.stoneLength)); // 锁面末端
    const E = add(D, scale(uI, pp.impulseLength)); // 传冲面末端
    // 背面闭合点
    const back = add(add(C, scale(uI, pp.stoneThickness * 0.5)), scale(uL, -pp.stoneThickness * 0.2));
    const poly = ensureCCW({
      name: side === 1 ? 'entry-stone' : 'exit-stone',
      points: [D, C, back, E],
      edgeLabels: ['stone-lock', null, null, 'stone-impulse'],
      body: 'pallet',
      pivot: palletPivot(p),
    });
    out.push({
      polygon: poly,
      side,
      radialAngle: alpha,
      discharge: D,
      lockSeg: { a: D, b: C },
      impulseSeg: { a: D, b: E },
    });
  }
  return out;
}

/** 叉体：连接两瓦的桥 + 叉柄 + 叉口槽（两壁为独立凸块） */
export interface ForkGeometry {
  parts: LabeledPolygon[];
  slotWalls: { entry: LabeledPolygon; exit: LabeledPolygon };
  slotCenter: Vec2;
}

export function buildFork(p: MechanismParams): ForkGeometry {
  const P = palletPivot(p);
  const B = balancePivot(p);
  const fp = p.fork;
  const dir = norm(sub(B, P));
  const tan = v(-dir.y, dir.x);
  const parts: LabeledPolygon[] = [];
  // 静止时冲击钉中心（位于摆轴朝向叉轴一侧）
  const pinRest = add(B, scale(norm(sub(P, B)), fp.pinRadiusFromBalance));
  const pinDist = dot(sub(pinRest, P), dir); // 钉中心沿叉柄方向到 P 的距离
  // 叉柄从 P 延伸到叉口末端
  const shankLen = pinDist + fp.slotLength * 0.55;
  const w = 0.16;
  const shank = ensureCCW({
    name: 'fork-shank',
    points: [
      add(P, scale(tan, -w)),
      add(P, scale(tan, w)),
      add(add(P, scale(dir, shankLen)), scale(tan, w)),
      add(add(P, scale(dir, shankLen)), scale(tan, -w)),
    ],
    edgeLabels: [null, null, null, null],
    body: 'pallet',
    pivot: P,
  });
  parts.push(shank);
  // 叉口槽：以静止钉中心为槽中心，沿叉柄方向开长度 slotLength 的槽
  const cCenter = add(P, scale(dir, pinDist));
  const c0 = add(cCenter, scale(dir, -fp.slotLength * 0.5));
  const c1 = add(cCenter, scale(dir, fp.slotLength * 0.5));
  const wall = (s: 1 | -1): LabeledPolygon => {
    const hw = fp.slotHalfWidth;
    const tw = 0.12;
    const inner = scale(tan, s * hw);
    const outer = scale(tan, s * (hw + tw));
    const p0 = add(c0, inner);
    const p1 = add(c1, inner); // 内壁（朝向槽中心）：p0->p1，标签在这条边
    const p2 = add(c1, outer);
    const p3 = add(c0, outer);
    // 显式排成逆时针，标签与边一一对应，避免 ensureCCW 反转错位
    const ordered = s === 1 ? [p0, p1, p2, p3] : [p1, p0, p3, p2];
    const poly: LabeledPolygon = {
      name: s === 1 ? 'slot-wall-entry' : 'slot-wall-exit',
      points: ordered,
      edgeLabels: [
        s === 1 ? 'fork-wall-entry' : 'fork-wall-exit',
        null,
        null,
        null,
      ],
      body: 'pallet',
      pivot: P,
    };
    return polygonArea(poly.points) < 0
      ? { ...poly, points: [...poly.points].reverse(), edgeLabels: [...poly.edgeLabels].reverse() }
      : poly;
  };
  const entry = wall(1);
  const exit = wall(-1);
  parts.push(entry, exit);
  return {
    parts,
    slotWalls: { entry, exit },
    slotCenter: add(P, scale(dir, shankLen - fp.slotLength * 0.5)),
  };
}

/** 冲击钉（随摆轮）：以摆轴为 pivot 的小圆柱多边形 */
export function buildRollerPin(p: MechanismParams): LabeledPolygon {
  const B = balancePivot(p);
  const fp = p.fork;
  // 静止时钉位于摆轴朝向叉轴一侧
  const c = add(B, scale(norm(sub(palletPivot(p), B)), fp.pinRadiusFromBalance));
  const n = 14;
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    pts.push(add(c, fromPolar(fp.pinRadius, a)));
  }
  return ensureCCW({
    name: 'roller-pin',
    points: pts,
    edgeLabels: new Array(n).fill(null),
    body: 'balance',
    pivot: B,
  });
}

/** 摆轮：轮缘（视觉用，不参与接触）+ 辐条 + 游丝螺旋（折线点集） */
export interface BalanceGeometry {
  ring: LabeledPolygon;
  spokes: LabeledPolygon[];
  pin: LabeledPolygon;
  hairspring: Vec2[];
  pinRestCenter: Vec2;
}

export function buildBalance(p: MechanismParams): BalanceGeometry {
  const B = balancePivot(p);
  const bp = p.balance;
  const n = 48;
  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    outer.push(add(B, fromPolar(bp.ringRadius, a)));
    inner.push(add(B, fromPolar(bp.ringRadius * 0.82, a)));
  }
  const ringPts = [...outer, ...inner.reverse()];
  const ring = ensureCCW({
    name: 'balance-ring',
    points: ringPts,
    edgeLabels: new Array(ringPts.length).fill(null),
    body: 'balance',
    pivot: B,
  });
  const spokes: LabeledPolygon[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * 2 * Math.PI;
    const d = fromPolar(1, a);
    const t = v(-d.y, d.x);
    const r0 = bp.ringRadius * 0.15;
    const r1 = bp.ringRadius * 0.82;
    const w = 0.1;
    spokes.push(
      ensureCCW({
        name: `spoke-${k}`,
        points: [
          add(add(B, scale(d, r0)), scale(t, -w)),
          add(add(B, scale(d, r1)), scale(t, -w)),
          add(add(B, scale(d, r1)), scale(t, w)),
          add(add(B, scale(d, r0)), scale(t, w)),
        ],
        edgeLabels: [null, null, null, null],
        body: 'balance',
        pivot: B,
      }),
    );
  }
  // 游丝：阿基米德螺旋，4 圈
  const hs: Vec2[] = [];
  const turns = 4;
  const steps = 220;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * 2 * Math.PI;
    const r = 0.18 + t * bp.ringRadius * 0.55;
    hs.push(add(B, fromPolar(r, a)));
  }
  const pin = buildRollerPin(p);
  return {
    ring,
    spokes,
    pin,
    hairspring: hs,
    pinRestCenter: pin.points.reduce(
      (acc, q) => add(acc, scale(q, 1 / pin.points.length)),
      v(0, 0),
    ),
  };
}

/** 固定件：限位钉两枚（小圆柱，参与限位接触） */
export function buildBankingPins(p: MechanismParams): LabeledPolygon[] {
  const P = palletPivot(p);
  const fp = p.fork;
  const r = 0.12;
  const n = 12;
  const out: LabeledPolygon[] = [];
  for (const side of [1, -1] as const) {
    const a = Math.PI / 2 + side * ((fp.bankingHalfAngleDeg * Math.PI) / 180);
    const c = add(P, fromPolar(fp.bankingRadius, a));
    const pts: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      pts.push(add(c, fromPolar(r, (i / n) * 2 * Math.PI)));
    }
    out.push(
      ensureCCW({
        name: side === 1 ? 'banking-entry' : 'banking-exit',
        points: pts,
        edgeLabels: new Array(n).fill(null),
        body: 'fixed',
        pivot: c,
      }),
    );
  }
  return out;
}

function ensureCCW(poly: LabeledPolygon): LabeledPolygon {
  if (polygonArea(poly.points) < 0) {
    const pts = [...poly.points].reverse();
    const labs = [...poly.edgeLabels].reverse();
    return { ...poly, points: pts, edgeLabels: labs };
  }
  return poly;
}

/** 全部静态几何打包 */
export interface MechanismGeometry {
  wheel: WheelGeometry;
  stones: PalletStoneGeometry[];
  fork: ForkGeometry;
  balance: BalanceGeometry;
  banking: LabeledPolygon[];
}

export function buildGeometry(p: MechanismParams): MechanismGeometry {
  return {
    wheel: buildWheel(p),
    stones: buildStones(p),
    fork: buildFork(p),
    balance: buildBalance(p),
    banking: buildBankingPins(p),
  };
}

export const TOOTH_FORMS: WheelToothForm[] = ['club', 'ratchet', 'steepClub'];
