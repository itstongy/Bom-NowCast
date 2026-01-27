#!/usr/bin/env node

/**
 * bom-nowcast (MVP)
 *
 * Fetches BOM radar frames from reg.bom.gov.au loop pages and does a crude
 * motion/proximity nowcast for a target lat/lon.
 *
 * Primary: Mt Stapylton (IDR663)
 * Fallback: Marburg (IDR503)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { Command } = require('commander');
const { PNG } = require('pngjs');

// Simple alpha compositing: draw src onto dst (both RGBA).
function alphaOver(dst, src) {
  if (dst.width !== src.width || dst.height !== src.height) {
    throw new Error('overlay size mismatch');
  }
  for (let i = 0; i < dst.data.length; i += 4) {
    const sr = src.data[i];
    const sg = src.data[i + 1];
    const sb = src.data[i + 2];
    const sa = src.data[i + 3] / 255;
    if (sa === 0) continue;

    const dr = dst.data[i];
    const dg = dst.data[i + 1];
    const db = dst.data[i + 2];
    const da = dst.data[i + 3] / 255;

    const outA = sa + da * (1 - sa);
    const outR = (sr * sa + dr * da * (1 - sa)) / (outA || 1);
    const outG = (sg * sa + dg * da * (1 - sa)) / (outA || 1);
    const outB = (sb * sa + db * da * (1 - sa)) / (outA || 1);

    dst.data[i] = Math.round(outR);
    dst.data[i + 1] = Math.round(outG);
    dst.data[i + 2] = Math.round(outB);
    dst.data[i + 3] = Math.round(outA * 255);
  }
}

const UA = 'Mozilla/5.0 (Clawdbot bom-nowcast-js)';

const RADARS = {
  IDR663: { name: 'Brisbane (Mt Stapylton) 128km', radarLat: -27.718, radarLon: 153.240, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR663.loop.shtml' },
  IDR503: { name: 'Brisbane (Marburg) 128km', radarLat: -27.61, radarLon: 152.54, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR503.loop.shtml' },
};

function cacheDir() {
  return path.join(os.homedir(), '.cache', 'bom-nowcast');
}

function overlayDir() {
  return path.join(cacheDir(), '_overlays');
}

async function fetchPng(url) {
  const buf = await httpGet(url);
  return PNG.sync.read(buf);
}

async function ensureOverlay(radarId, feature) {
  const dir = overlayDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${radarId}.${feature}.png`;
  const out = path.join(dir, file);
  if (!fs.existsSync(out)) {
    const url = `https://reg.bom.gov.au/products/radar_transparencies/${file}`;
    const data = await httpGet(url);
    fs.writeFileSync(out, data);
  }
  return PNG.sync.read(fs.readFileSync(out));
}

async function ensureLegend(type = 0) {
  const dir = overlayDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `IDR.legend.${type}.png`;
  const out = path.join(dir, file);
  if (!fs.existsSync(out)) {
    const url = `https://reg.bom.gov.au/products/radar_transparencies/${file}`;
    const data = await httpGet(url);
    fs.writeFileSync(out, data);
  }
  return PNG.sync.read(fs.readFileSync(out));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`timeout GET ${url}`));
    });
  });
}

async function headOk(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': UA } }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function pickRadar(preferred) {
  const order = preferred && RADARS[preferred] ? [preferred] : [];
  for (const k of Object.keys(RADARS)) if (!order.includes(k)) order.push(k);

  for (const id of order) {
    // liveness probe: gif exists
    const ok = await headOk(`https://reg.bom.gov.au/radar/${id}.gif`);
    if (ok) return id;
  }
  throw new Error(`No working radar among: ${order.join(', ')}`);
}

async function scrapeFrames(radarId) {
  const html = (await httpGet(RADARS[radarId].loopUrl)).toString('utf8');
  const re = /theImageNames\[\d+\]\s*=\s*"(?<path>\/radar\/[^\"]+?\.png)"/g;
  const frames = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const p = m.groups.path;
    const tsMatch = p.match(/\.(\d{12})\./);
    frames.push({
      url: `https://reg.bom.gov.au${p}`,
      ts: tsMatch ? tsMatch[1] : null,
      file: path.basename(p),
    });
  }
  // unique
  const seen = new Set();
  const uniq = [];
  for (const f of frames) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    uniq.push(f);
  }
  return uniq;
}

function latlonDeltaKm(lat0, lon0, lat1, lon1) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const lat0r = toRad(lat0);
  const lat1r = toRad(lat1);
  const dlat = toRad(lat1 - lat0);
  const dlon = toRad(lon1 - lon0);
  const x = dlon * Math.cos((lat0r + lat1r) / 2);
  const y = dlat;
  return { dxKm: x * R, dyKm: y * R };
}

function latlonToPixel({ radarLat, radarLon, radiusKm }, targetLat, targetLon, width, height) {
  if (width !== height) throw new Error('expected square radar image');
  const { dxKm, dyKm } = latlonDeltaKm(radarLat, radarLon, targetLat, targetLon);
  const radiusPx = width / 2;
  const kmPerPx = radiusKm / radiusPx;
  const cx = width / 2;
  const cy = height / 2;
  const x = Math.round(cx + dxKm / kmPerPx);
  const y = Math.round(cy - dyKm / kmPerPx);
  if (x < 0 || y < 0 || x >= width || y >= height) throw new Error('target outside image bounds');
  return { x, y, kmPerPx };
}

function precipMask(png) {
  // BOM composite PNGs contain lots of opaque overlays (coastlines, labels, rings).
  // We want *precip* only. Heuristic: precip pixels are colored (not grayscale)
  // and non-transparent.
  const w = png.width;
  const h = png.height;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = png.data[i * 4 + 0];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    const a = png.data[i * 4 + 3];

    if (a === 0) continue;

    // ignore grayscale overlays (rings/labels/coast): r==g==b
    if (r === g && g === b) continue;

    // otherwise treat as precip
    mask[i] = 1;
  }
  return mask;
}

function centroid(mask, w) {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    sx += x;
    sy += y;
    n++;
  }
  if (n === 0) return { cx: 0, cy: 0, n: 0 };
  return { cx: sx / n, cy: sy / n, n };
}

function nearestTrueDistance(mask, w, tx, ty, maxR = 250) {
  let best = Infinity;
  for (let dy = -maxR; dy <= maxR; dy++) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (x < 0 || y < 0 || x >= w || y >= w) continue;
      if (mask[y * w + x]) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

async function loadPng(filePath) {
  const buf = fs.readFileSync(filePath);
  return PNG.sync.read(buf);
}

async function ensureFrames(radarId, count) {
  const dir = path.join(cacheDir(), radarId);
  fs.mkdirSync(dir, { recursive: true });
  const frames = await scrapeFrames(radarId);
  const chosen = frames.slice(-count);
  for (const f of chosen) {
    const out = path.join(dir, f.file);
    if (fs.existsSync(out)) continue;
    const data = await httpGet(f.url);
    fs.writeFileSync(out, data);
  }
  return chosen.map((f) => path.join(dir, f.file));
}

async function renderCompositeFrame(radarId, framePath) {
  // Compose: background -> radar frame -> locations (place names).
  // This gives you geographic context.
  const bg = await ensureOverlay(radarId, 'background');
  const loc = await ensureOverlay(radarId, 'locations');

  const radar = PNG.sync.read(fs.readFileSync(framePath));
  const out = new PNG({ width: radar.width, height: radar.height });
  out.data.fill(0);

  // Some overlays are smaller than the radar frame; Mt Stapylton background is 512x512 (matches).
  // If mismatch: skip that overlay.
  if (bg.width === out.width && bg.height === out.height) alphaOver(out, bg);
  alphaOver(out, radar);
  if (loc.width === out.width && loc.height === out.height) alphaOver(out, loc);

  return out;
}

function bbox(mask, w) {
  let minX = w, minY = w, maxX = -1, maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

function expandBox(box, w, pad) {
  if (!box) return null;
  return {
    minX: Math.max(0, box.minX - pad),
    minY: Math.max(0, box.minY - pad),
    maxX: Math.min(w - 1, box.maxX + pad),
    maxY: Math.min(w - 1, box.maxY + pad),
  };
}

function bestShift(mask0, mask1, w, box, maxShift = 25) {
  // Find (dx,dy) applied to mask0 that maximizes overlap with mask1.
  // Score = sum(mask0(x-dx,y-dy) & mask1(x,y)) over box.
  if (!box) return { dx: 0, dy: 0, score: 0 };

  let best = { dx: 0, dy: 0, score: -1 };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let score = 0;
      for (let y = box.minY; y <= box.maxY; y++) {
        const y0 = y - dy;
        if (y0 < 0 || y0 >= w) continue;
        for (let x = box.minX; x <= box.maxX; x++) {
          const x0 = x - dx;
          if (x0 < 0 || x0 >= w) continue;
          if (mask1[y * w + x] && mask0[y0 * w + x0]) score++;
        }
      }
      if (score > best.score) best = { dx, dy, score };
    }
  }
  return best;
}

async function nowcast(radarId, lat, lon, frames = 6, mode = 'local') {
  const files = await ensureFrames(radarId, Math.max(frames, 2));
  const recent = files.slice(-frames);
  const imgs = [];
  for (const f of recent) imgs.push(await loadPng(f));

  const w = imgs[0].width;
  const radar = RADARS[radarId];
  const { x: tx, y: ty, kmPerPx } = latlonToPixel(radar, lat, lon, w, w);

  const masks = imgs.map(precipMask);
  const last = masks[masks.length - 1];
  const prev = masks[masks.length - 2];

  const rainNow = last[ty * w + tx] === 1;
  const rainPixels = last.reduce((a, b) => a + b, 0);

  // Motion estimate:
  // - local: use bbox of precip near target (window), robust for your "will it rain on me" use.
  // - global: use bbox of whole precip field.
  let box = bbox(last, w);
  if (mode === 'local') {
    const win = 140; // px half-width window around target (tunable)
    const localBox = {
      minX: Math.max(0, tx - win),
      minY: Math.max(0, ty - win),
      maxX: Math.min(w - 1, tx + win),
      maxY: Math.min(w - 1, ty + win),
    };
    // Intersect with precip bbox to reduce empty search.
    if (box) {
      box = {
        minX: Math.max(localBox.minX, box.minX),
        minY: Math.max(localBox.minY, box.minY),
        maxX: Math.min(localBox.maxX, box.maxX),
        maxY: Math.min(localBox.maxY, box.maxY),
      };
      if (box.minX > box.maxX || box.minY > box.maxY) box = localBox;
    } else {
      box = localBox;
    }
  }
  box = expandBox(box, w, 10);

  // Find best shift from prev -> last
  const shift = bestShift(prev, last, w, box, 20);
  const dt = 5; // minutes per frame
  let vx = shift.dx / dt;
  let vy = shift.dy / dt;

  // Fallback: if correlation is too weak, use centroid drift over available frames.
  if (shift.score < 300) {
    const vxs = [], vys = [];
    for (let i = 1; i < masks.length; i++) {
      const c0 = centroid(masks[i - 1], w);
      const c1 = centroid(masks[i], w);
      if (c0.n < 1000 || c1.n < 1000) continue;
      vxs.push((c1.cx - c0.cx) / dt);
      vys.push((c1.cy - c0.cy) / dt);
    }
    if (vxs.length) {
      vx = vxs.reduce((a, b) => a + b, 0) / vxs.length;
      vy = vys.reduce((a, b) => a + b, 0) / vys.length;
    }
  }

  const speed = Math.sqrt(vx * vx + vy * vy);

  const distPx = nearestTrueDistance(last, w, tx, ty);
  const etaMin = rainPixels === 0
    ? null
    : (rainNow ? 0 : (speed > 0.15 && isFinite(distPx) ? distPx / speed : null));

  const conf = rainPixels === 0
    ? 0.85
    : (etaMin !== null
      ? Math.max(0, Math.min(1, (1 - Math.min(distPx, 200) / 200) * Math.min(1, speed / 4)))
      : (rainNow ? 0.9 : 0.25));

  return {
    radarId,
    radarName: radar.name,
    mode,
    targetPixel: { x: tx, y: ty },
    kmPerPx,
    rainNow,
    rainPixels,
    etaMin,
    confidence: conf,
    motionPxPerMin: { vx, vy },
    motionKmPerMin: { vx: vx * kmPerPx, vy: vy * kmPerPx },
    debug: { shiftScore: shift.score },
  };
}

const program = new Command();
program
  .name('bom-nowcast')
  .description('BOM radar frame fetch + crude rain nowcast (Mt Stapylton primary, Marburg fallback)');

program
  .command('radars')
  .description('List known radars')
  .action(() => {
    for (const [id, r] of Object.entries(RADARS)) {
      console.log(`${id}  ${r.name}`);
    }
  });

program
  .command('fetch')
  .description('Fetch latest radar frames into cache')
  .option('--radar <id>', 'Radar product id (IDR663/IDR503)', 'IDR663')
  .option('--frames <n>', 'Number of frames', '10')
  .action(async (opts) => {
    const chosen = await pickRadar(opts.radar);
    const n = parseInt(opts.frames, 10);
    const files = await ensureFrames(chosen, n);
    console.log(`radar: ${chosen} (${RADARS[chosen].name})`);
    console.log(`saved: ${files.length} frames -> ${path.join(cacheDir(), chosen)}`);
  });

program
  .command('loop')
  .description('Render a geographic-context loop GIF (background + frames + labels)')
  .option('--radar <id>', 'Preferred radar (auto fallback)', 'IDR663')
  .option('--frames <n>', 'Frames to include', '7')
  .option('--out <path>', 'Output gif path', '/tmp/bom-nowcast-loop.gif')
  .action(async (opts) => {
    const chosen = await pickRadar(opts.radar);
    const n = parseInt(opts.frames, 10);
    const files = await ensureFrames(chosen, n);
    const recent = files.slice(-n);

    const outDir = '/tmp/bom-nowcast-render';
    fs.mkdirSync(outDir, { recursive: true });

    const rendered = [];
    for (const f of recent) {
      const frame = await renderCompositeFrame(chosen, f);
      const outPng = path.join(outDir, path.basename(f));
      fs.writeFileSync(outPng, PNG.sync.write(frame));
      rendered.push(outPng);
    }

    // Build GIF via ImageMagick if available.
    const { execSync } = require('child_process');
    const outGif = opts.out;
    try {
      execSync(`magick -delay 70 -loop 0 ${rendered.map((p)=>`"${p}"`).join(' ')} "${outGif}"`);
    } catch {
      execSync(`convert -delay 70 -loop 0 ${rendered.map((p)=>`"${p}"`).join(' ')} "${outGif}"`);
    }

    console.log(`radar: ${chosen} (${RADARS[chosen].name})`);
    console.log(`loop: ${outGif}`);
  });

program
  .command('nowcast')
  .description('Nowcast rain for a target lat/lon')
  .requiredOption('--lat <lat>')
  .requiredOption('--lon <lon>')
  .option('--radar <id>', 'Preferred radar (auto fallback)', 'IDR663')
  .option('--frames <n>', 'Frames to use', '6')
  .option('--mode <mode>', 'local|global motion estimate (default: local)', 'local')
  .action(async (opts) => {
    const lat = parseFloat(opts.lat);
    const lon = parseFloat(opts.lon);
    const n = parseInt(opts.frames, 10);
    const mode = opts.mode;
    const chosen = await pickRadar(opts.radar);
    const r = await nowcast(chosen, lat, lon, n, mode);

    console.log(`radar: ${r.radarId} (${r.radarName})`);
    console.log(`mode: ${r.mode}`);
    console.log(`rain_pixels: ${r.rainPixels}`);
    console.log(`rain_now: ${r.rainNow}`);
    console.log(`eta_min: ${r.etaMin === null ? 'none' : Math.round(r.etaMin)}`);
    console.log(`confidence: ${r.confidence.toFixed(2)}`);
    console.log(`motion_px_per_min: vx=${r.motionPxPerMin.vx.toFixed(2)} vy=${r.motionPxPerMin.vy.toFixed(2)}`);
    console.log(`motion_km_per_min: vx=${r.motionKmPerMin.vx.toFixed(2)} vy=${r.motionKmPerMin.vy.toFixed(2)}`);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
