/**
 * 场景装配：把 core 的参数化几何转成 GPU 渲染对象，
 * 并提供"当前状态 -> 各刚体网格"的统一入口。
 */
import type { MechanismParams } from '../core/types';
import { buildGeometry } from '../core/geometry';
import { extrudePolygon } from './mesh';
import type { EscapementRenderer } from './renderer';

export interface SceneHandle {
  objectNames: string[];
}

/** 爆炸拆解时各零件的位移方向（远离机构中心） */
const EXPLODE: Record<string, [number, number, number]> = {
  'wheel-outline': [-3.2, 0, 1.2],
  'entry-stone': [1.2, 1.6, 1.6],
  'exit-stone': [1.2, -1.6, 1.6],
  'fork-shank': [2.2, 0.6, 0.4],
  'slot-wall-entry': [2.2, 1.0, 0.8],
  'slot-wall-exit': [2.2, 0.2, 0.8],
  'roller-pin': [0, 2.2, 1.8],
  'balance-ring': [0, 3.2, 1.4],
};

export function buildScene(
  renderer: EscapementRenderer,
  params: MechanismParams,
): SceneHandle {
  const geo = buildGeometry(params);
  const objectNames: string[] = [];

  // 擒纵轮（整体轮廓）
  renderer.addObject('wheel-outline', extrudePolygon(geo.wheel.outline, 0.3), 'wheel', EXPLODE['wheel-outline']);
  objectNames.push('wheel-outline');

  // 叉瓦
  for (const stone of geo.stones) {
    renderer.addObject(stone.polygon.name, extrudePolygon(stone.polygon, 0.4), 'pallet', EXPLODE[stone.polygon.name]);
    objectNames.push(stone.polygon.name);
  }

  // 叉体与叉口壁
  for (const part of geo.fork.parts) {
    renderer.addObject(part.name, extrudePolygon(part, 0.26), 'pallet', EXPLODE[part.name] ?? [1.5, 0, 0.5]);
    objectNames.push(part.name);
  }

  // 摆轮、辐条、冲击钉
  renderer.addObject('balance-ring', extrudePolygon(geo.balance.ring, 0.18), 'balance', EXPLODE['balance-ring']);
  objectNames.push('balance-ring');
  for (let i = 0; i < geo.balance.spokes.length; i++) {
    const sp = geo.balance.spokes[i];
    renderer.addObject(sp.name, extrudePolygon(sp, 0.16), 'balance', [0, 3.0, 1.0]);
    objectNames.push(sp.name);
  }
  renderer.addObject('roller-pin', extrudePolygon(geo.balance.pin, 0.5), 'balance', EXPLODE['roller-pin']);
  objectNames.push('roller-pin');

  // 固定限位钉
  for (const pin of geo.banking) {
    renderer.addObject(pin.name, extrudePolygon(pin, 0.5), 'fixed', [0, pin.name.includes('entry') ? 1.5 : -1.5, 0.6]);
    objectNames.push(pin.name);
  }

  return { objectNames };
}
