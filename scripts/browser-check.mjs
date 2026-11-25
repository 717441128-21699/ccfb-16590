import { chromium } from 'playwright-core';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browser = await chromium.launch({
  executablePath: edge,
  headless: true,
  args: ['--headless=new', '--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-webgpu-developer-features'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const messages = [];
page.on('console', (msg) => messages.push(`${msg.type()}: ${msg.text()}`));
page.on('pageerror', (err) => messages.push(`pageerror: ${err.stack || err.message}`));
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: 'browser-demo.png' });
await page.getByRole('button', { name: '分阶段慢放' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'browser-phases.png' });
await page.getByRole('button', { name: '零件拆解' }).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'browser-explode.png' });
await page.getByRole('button', { name: '参数调节' }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: '负深度打滑' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'browser-slip.png' });
await page.getByRole('button', { name: '倒钩卡滞' }).click();
await page.locator('[data-param="sectionCut"]').check();
await page.waitForTimeout(1000);
await page.screenshot({ path: 'browser-jam-section.png' });
const pill = await page.locator('#webgpu-pill').textContent();
const badge = await page.locator('#gpu-badge').textContent();
console.log(JSON.stringify({ pill, badge, messages: messages.slice(-30) }, null, 2));
await browser.close();
