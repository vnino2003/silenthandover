// Generates the Android app icons and launch screens from the Silent Handover logo.
// Run from frontend/:  node scripts/android-icons.cjs
// Uses only pngjs (already installed). Re-run whenever public/silent-handover-logo.png changes.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const res = path.join(root, 'android/app/src/main/res');
const logo = PNG.sync.read(fs.readFileSync(path.join(root, 'public/silent-handover-logo.png')));

/** Area-averaged (premultiplied) sample of the logo for one target pixel. */
function sampleLogo(x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      if (x < 0 || y < 0 || x >= logo.width || y >= logo.height) continue;
      const i = (y * logo.width + x) * 4;
      const al = logo.data[i + 3] / 255;
      r += logo.data[i] * al; g += logo.data[i + 1] * al; b += logo.data[i + 2] * al; a += al; n++;
    }
  }
  if (!n || !a) return [0, 0, 0, 0];
  return [r / a, g / a, b / a, a / n];
}

/**
 * Draws an image of w x h: optional background colour, the logo centred at `scale` of the shorter
 * side, and an optional circular mask (round icons).
 */
function render(w, h, { scale, background = null, circle = false }) {
  const png = new PNG({ width: w, height: h });
  const size = Math.round(Math.min(w, h) * scale);
  const ox = (w - size) / 2;
  const oy = (h - size) / 2;
  const k = logo.width / size;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      if (background) [r, g, b, a] = [...background, 1];
      const lx = x - ox;
      const ly = y - oy;
      if (lx >= 0 && ly >= 0 && lx < size && ly < size) {
        const [sr, sg, sb, sa] = sampleLogo(lx * k, ly * k, (lx + 1) * k, (ly + 1) * k);
        r = sr * sa + r * (1 - sa); g = sg * sa + g * (1 - sa); b = sb * sa + b * (1 - sa); a = sa + a * (1 - sa);
      }
      if (circle) {
        const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
        a *= Math.min(1, Math.max(0, w / 2 - d)); // smooth edge
      }
      const i = (y * w + x) * 4;
      png.data[i] = Math.round(r); png.data[i + 1] = Math.round(g); png.data[i + 2] = Math.round(b); png.data[i + 3] = Math.round(a * 255);
    }
  }
  return PNG.sync.write(png);
}

const WHITE = [255, 255, 255];
const write = (file, buf) => { fs.writeFileSync(path.join(res, file), buf); console.log('wrote', file); };

// Launcher icons: legacy square and round (logo with margin on white), and the adaptive-icon
// foreground (transparent, logo inside the 66% safe zone; the background colour is white).
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, m] of Object.entries(densities)) {
  const legacy = Math.round(48 * m);
  const fg = Math.round(108 * m);
  write(`mipmap-${d}/ic_launcher.png`, render(legacy, legacy, { scale: 0.98, background: WHITE }));
  write(`mipmap-${d}/ic_launcher_round.png`, render(legacy, legacy, { scale: 0.88, background: WHITE, circle: true }));
  write(`mipmap-${d}/ic_launcher_foreground.png`, render(fg, fg, { scale: 0.72 }));
}

// Launch screens: the logo centred on white.
for (const dir of fs.readdirSync(res).filter((f) => f === 'drawable' || f.startsWith('drawable-port') || f.startsWith('drawable-land'))) {
  const file = path.join(res, dir, 'splash.png');
  if (!fs.existsSync(file)) continue;
  const old = PNG.sync.read(fs.readFileSync(file));
  write(`${dir}/splash.png`, render(old.width, old.height, { scale: 0.35, background: WHITE }));
}
