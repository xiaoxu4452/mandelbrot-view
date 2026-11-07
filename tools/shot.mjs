import { chromium } from 'playwright-core';
const url = process.argv[2] || 'http://127.0.0.1:8777/index.html';
const out = process.argv[3] || 'tools/screen.png';
const wait = Number(process.argv[4] || 2500);
const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-gl=swiftshader', '--disable-gpu-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
console.log(logs.join('\n') || '(no console output)');
await browser.close();
