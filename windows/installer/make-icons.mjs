// Renders the ORIGINAL medlink-icon.svg (unchanged) into the PNG and ICO files Windows needs: the MSIX tile images
// and the MEDLINK.exe icon. Run only when the icon changes; the results are committed.
//   node make-icons.mjs   (needs playwright-core with Chromium, and python3 with Pillow for the .ico)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = path.join(here, '../MedLink.Windows/Assets/medlink-icon.svg');
const out = path.join(here, 'Assets');
const dataUrl = 'data:image/svg+xml;base64,' + fs.readFileSync(svg).toString('base64');
// size, padding (Windows draws tiles with some margin; the small icons use almost the whole square).
const targets = [['Square44x44Logo.png', 44, 0.06], ['Square150x150Logo.png', 150, 0.18], ['StoreLogo.png', 50, 0.06], ['icon-256.png', 256, 0.04]];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const [name, size, pad] of targets) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - 2 * pad));
  await page.setContent(`<html><body style="margin:0;background:transparent;display:grid;place-items:center;width:${size}px;height:${size}px">
    <img src="${dataUrl}" style="max-width:${inner}px;max-height:${inner}px"></body></html>`);
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: path.join(out, name), omitBackground: true });
}
await browser.close();
execFileSync('python3', ['-c', `from PIL import Image
Image.open(${JSON.stringify(path.join(out, 'icon-256.png'))}).save(${JSON.stringify(path.join(here, '../MedLink.Windows/Assets/medlink.ico'))}, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])`]);
fs.rmSync(path.join(out, 'icon-256.png'));
console.log('written:', fs.readdirSync(out).join(', '), '+ MedLink.Windows/Assets/medlink.ico');
