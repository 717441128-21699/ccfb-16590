import './styles.css';
import { store, type PageId } from './ui/store';
import { CanvasView } from './ui/canvas-view';
import { demoPage, slowmoPage, explodePage, paramsPage } from './ui/pages';

const PAGE_TITLES: Record<PageId, string> = {
  demo: '擒纵演示',
  slowmo: '分阶段慢放',
  explode: '零件拆解',
  params: '参数调节',
};

function renderNav() {
  const nav = document.querySelector('#nav')!;
  const pages: PageId[] = ['demo', 'slowmo', 'explode', 'params'];
  nav.innerHTML = pages
    .map(
      (p) =>
        `<button class="nav-btn ${store.state.page === p ? 'active' : ''}" data-page="${p}">${PAGE_TITLES[p]}</button>`,
    )
    .join('');
  nav.querySelectorAll<HTMLButtonElement>('.nav-btn').forEach((b) => {
    b.onclick = () => store.setPage(b.dataset.page as PageId);
  });
}

function renderPanel() {
  const host = document.querySelector('#panel')!;
  const s = store.state;
  host.innerHTML = '';
  const page =
    s.page === 'demo' ? demoPage(s)
    : s.page === 'slowmo' ? slowmoPage(s)
    : s.page === 'explode' ? explodePage(s)
    : paramsPage(s);
  host.appendChild(page);
}

function main() {
  const app = document.querySelector('#app')!;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">瑞士杠杆擒纵 · 三维教学教具</div>
      <nav id="nav" class="nav"></nav>
    </header>
    <main class="layout">
      <div class="canvas-wrap">
        <canvas id="gpu-canvas"></canvas>
        <div id="force-arrows" class="force-arrows"></div>
        <div class="canvas-hint">拖拽旋转 · 滚轮缩放</div>
      </div>
      <aside id="panel" class="panel-host"></aside>
    </main>
    <footer class="statusbar" id="status"></footer>
  `;

  const canvas = document.querySelector<HTMLCanvasElement>('#gpu-canvas')!;
  const arrowHost = document.querySelector<HTMLDivElement>('#force-arrows')!;
  const view = new CanvasView(canvas, arrowHost);
  void view.init();

  const status = document.querySelector('#status')!;
  const syncStatus = () => {
    const a = store.state.beat.analysis;
    status.textContent = `齿形 ${store.state.params.wheel.form} · ${
      a.ok ? '运行正常' : '检测到异常'
    } · 锁深 ${a.lockDepthDeg.toFixed(2)}° · 落下 ${Number.isFinite(a.dropAngleDeg) ? a.dropAngleDeg.toFixed(2) : '—'}° · ${
      store.state.beat.track.length
    } 帧轨迹`;
  };

  store.subscribe(() => {
    renderNav();
    renderPanel();
    syncStatus();
  });
  renderNav();
  renderPanel();
  syncStatus();
}

main();
