# 瑞士杠杆擒纵机构 · WebGPU 三维课堂教具

一个可直接在课堂大屏运行的 TypeScript + 原生 WebGPU 教具。机构不是按预录动画播放，而是由平面几何布局、接触段约束和相位状态共同求出擒纵轮、擒纵叉、叉瓦、冲击钉与摆轮游丝的位置。

> 需要支持 WebGPU 的桌面版 Edge / Chrome（建议最新版）。页面会检测 `navigator.gpu`；Node/Vitest 中运行的是与 WGSL 查询同源的 TypeScript 参考几何内核。

## 启动

```powershell
npm install
npm run dev
```

生产构建与预览：

```powershell
npm run build
npm run preview
```

几何、能量和节拍一致性测试：

```powershell
npm test
```

如果本机安装了 Microsoft Edge，可用 Playwright Core 做浏览器冒烟检查并生成四张页面截图：

```powershell
npm run build
node scripts/browser-check.mjs
```

## 四个教学页面

1. **擒纵演示**：完整机构、播放/暂停、速度、周期拖条、三维受力方向、接触点和 GPU 接触距离。
2. **分阶段慢放**：锁接、释放、传冲、落下四阶段；可逐帧拖动，可切换第 1/2 拍和上下叉瓦。
3. **零件拆解**：擒纵轮、擒纵叉、进入/退出叉瓦、冲击钉、圆盘、摆轮和游丝的爆炸视图与显隐。
4. **参数调节**：四种自编齿形、叉瓦锁接角、牵引角、深度偏置、力矩和摩擦；一键复现浅锁、负深度打滑和倒钩卡滞。

## 几何与教材数据

基准为 15 齿现代瑞士叉瓦式擒纵，采用教材制图中常见的 24° 齿距和 60° 叉瓦跨角切线构造：

| 量 | 基准值 | 几何来源 |
|---|---:|---|
| 擒纵轮齿数 | 15 | 齿距 `360/15 = 24°` |
| 每拍轮角 | 12° | 一个完整摆轮来回对应一个齿距，分两拍 |
| 两叉瓦跨角 | 60° | 轮心处 ±30°，即 2.5 个齿距间隔 |
| 总锁接角 | 2.00° | `1.5°` 落下锁接 + `0.5°` slide |
| 落下角 | 1.50° | `12° − 6° 叉瓦弧 − 4.5° 齿宽` |
| 叉瓦提升角 | 5.50° | `5½° lift on pallet` |
| 齿提升角 | 3.00° | `3° lift on tooth` |
| 传冲总提升 | 8.50° | `3° + 5.5°` |
| 叉全摆角 | 10.00° | `1.5° + 3° + 5.5°` |
| 摆轮提升角 | 52.00° | 由叉槽—冲击钉圆/射线相交几何反解校准 |
| 牵引角 | 12° | 叉瓦锁接面 draft/draw angle |

`tests/escapement.test.ts` 会重新从坐标向量计算这些角度，并断言所有标准项误差不超过 `0.2°`。

## 接触、能量和故障判定

- `src/geom/math.ts`：二维段相交、点到段投影、最近点和法向。
- `src/geom/escapement.ts`：叉瓦锁接面/冲面、轮齿角、叉轴角和冲击钉位置；释放与传冲时用二分法求“轮齿角点落在当前叉瓦工作面上”的约束根。
- `src/gpu/contactCompute.ts`：WGSL compute shader，对轮齿/接触点到叉瓦工作面做最近段查询，读回接触点、法向、距离和滑点参数 `t`。
- 传冲能量按虚功增量传播：

```text
dW_wheel  = τ_wheel · |dθ_wheel|
dE_balance = τ_balance · |dθ_balance|
τ_balance = τ_wheel · |dθ_wheel / dθ_balance|
```

理想无摩擦时，测试断言轮功和摆轮所得能量相对误差小于 `1e-9`。摩擦系数非零时显示摩擦功，并校验 `轮功 = 摆轮能量 + 摩擦功`。

当锁接角或有符号锁接深度 ≤ 0 时，页面和测试判定为**打滑/跳齿**；倒钩齿形或过深锁接会生成带零件和坐标的**卡滞诊断**，视口中 HUD 与右侧面板同时指出干涉接触对。

## 主要目录

```text
src/geom/       参数、教材数据、几何/相位/能量参考内核
src/gpu/        原生 WebGPU 渲染器、网格挤出、矩阵和 WGSL compute
src/ui/         TypeScript DOM 界面与交互
tests/          Vitest 几何、同步、能量和故障判定测试
scripts/        本机 Edge + Playwright Core 浏览器冒烟截图
```

## 参考资料

- Horopedia, *Swiss Lever Escapement*: <https://horopedia.org/swiss-lever-escapement/>
- Escapement.watch, *Lift Angle 101: 52°, 38°, and Why It Matters for Amplitude*: <https://escapement.watch/journal/lift-angle-guide>
- *Practical Lessons on the Lever Escapement*（24° 齿距、2° lock、1.5° drop、5.5° pallet lift、3° tooth lift、12° draft 等制图规范）: <https://archive.org/stream/practicallessons00wilk/practicallessons00wilk_djvu.txt>
- Horological Glossary / Watch Museum, *Unlocking — Escapement*: <https://explore.watchmuseum.org/glossary/unlocking-escapement>
- Mechanical Escapement Lab（15 齿、每拍 12° 的教学模型对照）: <https://www.mysimulator.uk/engineering/mechanical-escapement-swiss-lever-pendulum-clock-isochronism-lab/sim.html>
