#!/usr/bin/env node

/**
 * bom-nowcast (MVP)
 *
 * Fetches BOM radar frames from reg.bom.gov.au loop pages and does a crude
 * motion/proximity nowcast for a target lat/lon.
 *
 * Primary: Mt Stapylton 64 km (IDR664)
 * Fallback: Marburg (IDR503)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
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

const DEFAULT_CACHE_DAYS = 3;
const DEFAULT_LOOP_FRAMES = 7;
const DEFAULT_ETA_MAX_MIN = 120;
const ETA_CROSS_PX = 20;
const INTENSITY_RADIUS_PX = 6;
const DEFAULT_EMOJIS = ['🏠', '🏢', '🏫', '🏥', '🏖️', '🧭', '📍', '🌧️', '☂️', '🌤️', '⚡', '🚀', '⭐', '🧡', '💧', '🛰️'];
const INTENSITY_ORDER_HEX = [
  '#F5F5FF',
  '#B4B4FF',
  '#7878FF',
  '#1414FF',
  '#00D8C3',
  '#009690',
  '#066',
  '#FF0',
  '#FFC800',
  '#FF9600',
  '#FF6400',
  '#F00',
  '#C80000',
  '#780000',
  '#280000',
];

const ASCII_LOGO = [
  ' ____   ___  __  __       _   _  _____        ______    _    ____ _____ ',
  '| __ ) / _ \\|  \\/  |     | \\ | |/ _ \\ \\      / / ___|  / \\  / ___|_   _|',
  '|  _ \\| | | | |\\/| |_____|  \\| | | | \\ \\ /\\ / / |     / _ \\ \\___ \\ | |  ',
  '| |_) | |_| | |  | |_____| |\\  | |_| |\\ V  V /| |___ / ___ \\ ___) || |  ',
  '|____/ \\___/|_|  |_|     |_| \\_|\\___/  \\_/\\_/  \\____/_/   \\_\\____/ |_|  ',
  '                                                                        ',
];

const TERM = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

function termWidth() {
  const w = output.isTTY ? output.columns : 80;
  if (!w || Number.isNaN(w)) return 80;
  return Math.max(60, Math.min(w, 120));
}

function colorize(code, text) {
  if (!output.isTTY) return text;
  return `${code}${text}${TERM.reset}`;
}

function dim(text) {
  return colorize(TERM.dim, text);
}

function bold(text) {
  return colorize(TERM.bold, text);
}

function hr(char = '─') {
  return dim(char.repeat(termWidth()));
}

function printLogo() {
  if (!output.isTTY) return;
  const w = termWidth();
  const widest = ASCII_LOGO.reduce((m, l) => Math.max(m, l.length), 0);
  if (widest + 4 > w) return;
  for (const line of ASCII_LOGO) {
    console.log(colorize(TERM.cyan, line));
  }
  console.log(dim('Radar nowcast • BOM loop frames'));
  console.log(hr());
}

function fmtKv(icon, label, value, color = TERM.reset) {
  const key = `${icon} ${label}`;
  const padded = key.padEnd(18, ' ');
  return `${dim(padded)}${colorize(color, value)}`;
}

function fmtStatus(label, ok) {
  return ok ? colorize(TERM.green, label) : colorize(TERM.yellow, label);
}

function formatEta(etaMin, etaWindowMin) {
  if (etaMin === null) return colorize(TERM.dim, 'none');
  if (etaWindowMin === 0) return colorize(TERM.green, 'now');
  return `${colorize(TERM.cyan, Math.round(etaMin).toString())} ${dim(`±${etaWindowMin} min`)}`;
}

function formatIntensity(intensity) {
  if (!intensity) return colorize(TERM.dim, 'none');
  const likely = intensity.likelyLabel || 'none';
  const peak = intensity.peakLabel || 'none';
  if (likely === peak) return colorize(TERM.yellow, likely);
  return `${colorize(TERM.yellow, likely)} ${dim(`(peak ${peak})`)}`;
}

function formatConfidence(confidence) {
  const pct = Math.round((confidence || 0) * 100);
  const color = pct >= 70 ? TERM.green : pct >= 40 ? TERM.yellow : TERM.red;
  return colorize(color, `${pct}%`);
}

function noRainMessage() {
  return colorize(TERM.green, 'No rain detected nearby — no ETA needed.');
}

function configPath() {
  // XDG-ish: ~/.config/bom-nowcast/config.json
  return path.join(os.homedir(), '.config', 'bom-nowcast', 'config.json');
}

function loadConfig() {
  const p = configPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

function defaultConfig() {
  return {
    version: 1,
    defaultRadar: 'IDR664',
    cacheDays: DEFAULT_CACHE_DAYS,
    defaultLocation: 'Default',
    locations: {
      Default: {
        lat: -27.874798,
        lon: 153.296172,
      },
    },
  };
}

function getLocation(cfg, name) {
  if (!cfg || !cfg.locations) return null;
  return cfg.locations[name] || null;
}

const RADARS = {
  IDR664: { name: 'Brisbane (Mt Stapylton 64 km)', radarLat: -27.718, radarLon: 153.240, radiusKm: 64, loopUrl: 'https://reg.bom.gov.au/products/IDR664.loop.shtml' },
  IDR663: { name: 'Brisbane (Mt Stapylton)', radarLat: -27.718, radarLon: 153.240, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR663.loop.shtml' },
  IDR503: { name: 'Brisbane (Marburg)', radarLat: -27.61, radarLon: 152.54, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR503.loop.shtml' },
  IDR713: { name: 'Sydney (Terrey Hills)', radarLat: -33.707, radarLon: 151.210, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR713.loop.shtml' },
  IDR023: { name: 'Melbourne (Laverton)', radarLat: -37.855, radarLon: 144.752, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR023.loop.shtml' },
  IDR643: { name: 'Adelaide (Buckland Park)', radarLat: -34.615, radarLon: 138.469, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR643.loop.shtml' },
  IDR703: { name: 'Perth (Serpentine)', radarLat: -32.404, radarLon: 115.977, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR703.loop.shtml' },
  IDR633: { name: 'Darwin (Berrimah)', radarLat: -12.457, radarLon: 130.926, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR633.loop.shtml' },
  IDR763: { name: 'Hobart (Mt Koonya)', radarLat: -42.881, radarLon: 147.330, radiusKm: 128, loopUrl: 'https://reg.bom.gov.au/products/IDR763.loop.shtml' },
};

function cacheDir() {
  return path.join(os.homedir(), '.cache', 'bom-nowcast');
}

function pruneCache(dir, maxAgeDays) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (!name.endsWith('.png')) continue;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(p);
      }
    } catch {
      // ignore
    }
  }
}

function overlayDir() {
  return path.join(cacheDir(), '_overlays');
}

function emojiDir() {
  return path.join(cacheDir(), '_emoji');
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

let _legendPalette = null;

async function getLegendPalette() {
  // Extract a reflectivity colour palette from BOM's legend (type=0).
  // Row-scanning is brittle because the legend includes text. Instead we:
  // 1) collect all colours with counts (including greyscale; white=light rain, black=hail)
  // 2) keep only the high-frequency swatches (actual legend blocks)
  // 3) sort them by the known intensity ordering from the legend image.
  if (_legendPalette) return _legendPalette;

  const legend = await ensureLegend(0);
  const w = legend.width;
  const h = legend.height;

  const counts = new Map();
  for (let i = 0; i < w * h; i++) {
    const r = legend.data[i * 4 + 0];
    const g = legend.data[i * 4 + 1];
    const b = legend.data[i * 4 + 2];
    const a = legend.data[i * 4 + 3];
    if (a === 0) continue;

    const k = colorKey(r, g, b);
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  // Keep only swatches that clearly come from the legend colour bars.
  const swatches = [...counts.entries()]
    .filter(([, c]) => c >= 120)
    .map(([k, c]) => ({ rgb: parseColorKey(k), c }));

  // Sort from low→high intensity using the legend's ordered swatches.
  const orderRgb = INTENSITY_ORDER_HEX.map(hexToRgb);
  swatches.sort((a, b) => {
    const aIdx = nearestOrderIndex(a.rgb, orderRgb);
    const bIdx = nearestOrderIndex(b.rgb, orderRgb);
    if (aIdx !== bIdx) return aIdx - bIdx;
    return colorDistSq(a.rgb, orderRgb[aIdx]) - colorDistSq(b.rgb, orderRgb[bIdx]);
  });

  const palette = swatches.map((s) => s.rgb);
  _legendPalette = palette;
  return palette;
}

function classifyIntensityBand(rgb, palette) {
  // Return palette index of the nearest legend colour.
  // Lower index = lower intensity (as ordered in legend image top->bottom).
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = colorDistSq(rgb, palette[i]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function bandToLabel(band, bandCount) {
  if (bandCount <= 1) return 'unknown';
  const t = band / (bandCount - 1);
  if (t < 0.34) return 'light';
  if (t < 0.67) return 'moderate';
  if (t < 0.90) return 'heavy';
  return 'very heavy';
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

function isGrayish(r, g, b, tol = 0) {
  return Math.abs(r - g) <= tol && Math.abs(g - b) <= tol && Math.abs(r - b) <= tol;
}

function colorKey(r, g, b) {
  return `${r},${g},${b}`;
}

function parseColorKey(k) {
  const [r, g, b] = k.split(',').map((x) => parseInt(x, 10));
  return { r, g, b };
}

function colorDistSq(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return { r: 0, g: 0, b: 0 };
}

function nearestOrderIndex(rgb, order) {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < order.length; i++) {
    const d = colorDistSq(rgb, order[i]);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  return bestI;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function precipMask(png) {
  // BOM radar frames include overlays (rings/labels/coast). For motion/ETA we only
  // want the precipitation blobs. Heuristic: precipitation pixels are *coloured*
  // (not greyscale) and opaque.
  const w = png.width;
  const h = png.height;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = png.data[i * 4 + 0];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    const a = png.data[i * 4 + 3];

    if (a === 0) continue;
    if (isGrayish(r, g, b, 0)) continue;

    // otherwise treat as precip
    mask[i] = 1;
  }
  return mask;
}

function buildBandMap(png, palette) {
  const w = png.width;
  const h = png.height;
  const bands = new Int16Array(w * h);
  bands.fill(-1);
  if (!palette || palette.length === 0) return bands;
  for (let i = 0; i < w * h; i++) {
    const r = png.data[i * 4 + 0];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    const a = png.data[i * 4 + 3];
    if (a === 0) continue;
    if (isGrayish(r, g, b, 0)) continue;
    const band = classifyIntensityBand({ r, g, b }, palette);
    bands[i] = band;
  }
  return bands;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function median(sorted) {
  return percentile(sorted, 0.5);
}

function intensityFromBands(bands, paletteCount) {
  if (!bands || bands.length === 0 || paletteCount <= 0) {
    return { likelyBand: null, peakBand: null, likelyLabel: 'none', peakLabel: 'none' };
  }
  const sorted = [...bands].sort((a, b) => a - b);
  const likelyBand = Math.round(median(sorted));
  const peakBand = sorted[sorted.length - 1];
  return {
    likelyBand,
    peakBand,
    likelyLabel: likelyBand === null ? 'none' : bandToLabel(likelyBand, paletteCount),
    peakLabel: peakBand === null ? 'none' : bandToLabel(peakBand, paletteCount),
  };
}

function sampleBandsRadius(bandMap, w, tx, ty, radiusPx) {
  const bands = [];
  const r2 = radiusPx * radiusPx;
  for (let y = Math.max(0, ty - radiusPx); y <= Math.min(w - 1, ty + radiusPx); y++) {
    for (let x = Math.max(0, tx - radiusPx); x <= Math.min(w - 1, tx + radiusPx); x++) {
      const dx = x - tx;
      const dy = y - ty;
      if (dx * dx + dy * dy > r2) continue;
      const band = bandMap[y * w + x];
      if (band >= 0) bands.push(band);
    }
  }
  return bands;
}

function collectEtaCandidates(mask, bandMap, w, tx, ty, vx, vy, maxEtaMin) {
  const v2 = vx * vx + vy * vy;
  const vMag = Math.sqrt(v2);
  if (vMag < 0.1) return { times: [], bands: [] };
  const times = [];
  const bands = [];
  const maxEta = maxEtaMin || DEFAULT_ETA_MAX_MIN;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    const dx = tx - x;
    const dy = ty - y;
    const dot = dx * vx + dy * vy;
    if (dot <= 0) continue;
    const t = dot / v2;
    if (t > maxEta) continue;
    const cross = Math.abs(dx * vy - dy * vx) / vMag;
    if (cross > ETA_CROSS_PX) continue;
    times.push(t);
    const band = bandMap[i];
    if (band >= 0) bands.push(band);
  }
  return { times, bands };
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

async function ensureFrames(radarId, count, cacheDays = DEFAULT_CACHE_DAYS) {
  const dir = path.join(cacheDir(), radarId);
  fs.mkdirSync(dir, { recursive: true });

  // prune old cached frames to keep disk usage bounded
  pruneCache(dir, cacheDays);

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

function alphaOverAt(dst, src, x0, y0) {
  for (let y = 0; y < src.height; y++) {
    const yy = y0 + y;
    if (yy < 0 || yy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const xx = x0 + x;
      if (xx < 0 || xx >= dst.width) continue;
      const di = (yy * dst.width + xx) * 4;
      const si = (y * src.width + x) * 4;

      const sr = src.data[si];
      const sg = src.data[si + 1];
      const sb = src.data[si + 2];
      const sa = src.data[si + 3] / 255;
      if (sa === 0) continue;

      const dr = dst.data[di];
      const dg = dst.data[di + 1];
      const db = dst.data[di + 2];
      const da = dst.data[di + 3] / 255;

      const outA = sa + da * (1 - sa);
      const outR = (sr * sa + dr * da * (1 - sa)) / (outA || 1);
      const outG = (sg * sa + dg * da * (1 - sa)) / (outA || 1);
      const outB = (sb * sa + db * da * (1 - sa)) / (outA || 1);

      dst.data[di] = Math.round(outR);
      dst.data[di + 1] = Math.round(outG);
      dst.data[di + 2] = Math.round(outB);
      dst.data[di + 3] = Math.round(outA * 255);
    }
  }
}

function scalePng(src, size) {
  const out = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y / size) * src.height);
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * src.width);
      const si = (sy * src.width + sx) * 4;
      const di = (y * size + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

function emojiToCodepoints(emoji) {
  return Array.from(emoji).map((ch) => ch.codePointAt(0).toString(16)).join('-');
}

const emojiPngCache = new Map();

async function ensureEmojiPng(emoji) {
  if (emojiPngCache.has(emoji)) return emojiPngCache.get(emoji);
  const dir = emojiDir();
  fs.mkdirSync(dir, { recursive: true });
  const code = emojiToCodepoints(emoji);
  const file = `${code}.png`;
  const out = path.join(dir, file);
  if (!fs.existsSync(out)) {
    const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${file}`;
    const data = await httpGet(url);
    fs.writeFileSync(out, data);
  }
  const png = PNG.sync.read(fs.readFileSync(out));
  emojiPngCache.set(emoji, png);
  return png;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function resolveLocationEmoji(name, loc) {
  if (loc && loc.emoji) return loc.emoji;
  const idx = Math.abs(hashString(name)) % DEFAULT_EMOJIS.length;
  return DEFAULT_EMOJIS[idx];
}

function hasCommand(cmd) {
  const { execSync } = require('child_process');
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function renderLoopGif(radarId, frameCount, outGif, locations, cacheDays) {
  const n = parseInt(frameCount, 10);
  const files = await ensureFrames(radarId, n, cacheDays || DEFAULT_CACHE_DAYS);
  const recent = files.slice(-n);

  const outDir = '/tmp/bom-nowcast-render';
  fs.mkdirSync(outDir, { recursive: true });

  const rendered = [];
  for (const f of recent) {
    const frame = await renderCompositeFrame(radarId, f, locations || {});
    const outPng = path.join(outDir, path.basename(f));
    fs.writeFileSync(outPng, PNG.sync.write(frame));
    rendered.push(outPng);
  }

  // Build GIF via ImageMagick if available.
  const { execSync } = require('child_process');
  try {
    execSync(`magick -delay 70 -loop 0 ${rendered.map((p)=>`"${p}"`).join(' ')} "${outGif}"`);
  } catch {
    execSync(`convert -delay 70 -loop 0 ${rendered.map((p)=>`"${p}"`).join(' ')} "${outGif}"`);
  }

  return outGif;
}

async function runSetup() {
  const existing = loadConfig() || defaultConfig();
  const rl = readline.createInterface({ input, output });
  const ask = async (label, def) => {
    const suffix = def !== undefined && def !== null && def !== '' ? ` [${def}]` : '';
    const ans = (await rl.question(`${label}${suffix}: `)).trim();
    return ans === '' ? def : ans;
  };
  const askNumber = async (label, def) => {
    while (true) {
      const raw = await ask(label, def);
      const num = parseFloat(raw);
      if (!Number.isNaN(num) && Number.isFinite(num)) return num;
      console.log('Please enter a valid number.');
    }
  };
  const askYesNo = async (label, def = true) => {
    const hint = def ? 'Y/n' : 'y/N';
    const raw = (await ask(`${label} (${hint})`, def ? 'y' : 'n')).toLowerCase();
    if (['y', 'yes'].includes(raw)) return true;
    if (['n', 'no'].includes(raw)) return false;
    return def;
  };

  console.log('');
  printLogo();
  console.log(bold('Setup'));
  console.log('');
  console.log('Available radars:');
  for (const [id, r] of Object.entries(RADARS)) {
    console.log(`- ${id}: ${r.name}`);
  }

  let radarId = await ask('Default radar ID', existing.defaultRadar || 'IDR663');
  while (!RADARS[radarId]) {
    console.log('Please enter a supported radar ID from the list above.');
    radarId = await ask('Default radar ID', existing.defaultRadar || 'IDR663');
  }

  const existingDefaultName = existing.defaultLocation || 'Default';
  const existingDefaultLoc = getLocation(existing, existingDefaultName) || defaultConfig().locations.Default;

  const defaultName = await ask('Default location name', existingDefaultName);
  const defaultLat = await askNumber('Default location latitude', existingDefaultLoc.lat);
  const defaultLon = await askNumber('Default location longitude', existingDefaultLoc.lon);
  const emojiHint = DEFAULT_EMOJIS.join(' ');
  const defaultEmoji = await ask(`Default location emoji (examples: ${emojiHint})`, existingDefaultLoc.emoji || '');

  const cfg = {
    version: existing.version || 1,
    defaultRadar: radarId,
    cacheDays: existing.cacheDays || DEFAULT_CACHE_DAYS,
    defaultLocation: defaultName,
    locations: { ...(existing.locations || {}) },
  };

  cfg.locations[defaultName] = {
    lat: defaultLat,
    lon: defaultLon,
    emoji: defaultEmoji || existingDefaultLoc.emoji,
  };

  while (await askYesNo('Add another location pin', false)) {
    const name = await ask('Location name', '');
    if (!name) {
      console.log('Skipping empty name.');
      continue;
    }
    const lat = await askNumber('Latitude', '');
    const lon = await askNumber('Longitude', '');
    const emoji = await ask(`Emoji for ${name}`, resolveLocationEmoji(name, cfg.locations[name]));
    cfg.locations[name] = { lat, lon, emoji };
  }

  saveConfig(cfg);
  rl.close();
  console.log(`\nSaved config: ${configPath()}`);
  return cfg;
}

async function runDefault() {
  let cfg = loadConfig();
  if (!cfg) {
    console.log('No config found. Starting setup...\n');
    cfg = await runSetup();
  }
  if (!cfg.defaultRadar || !cfg.defaultLocation || !getLocation(cfg, cfg.defaultLocation)) {
    console.log('Config incomplete. Starting setup...\n');
    cfg = await runSetup();
  }

  const preferred = cfg.defaultRadar || 'IDR663';
  const chosen = await pickRadar(preferred);
  const defaultLoc = cfg.defaultLocation;
  const loc = getLocation(cfg, defaultLoc);

  if (loc) {
    const now = await nowcastLocations(chosen, { [defaultLoc]: loc }, DEFAULT_LOOP_FRAMES, 'local');
    const entry = now.locations[0];
    printLogo();
    console.log(bold(`Nowcast`));
    console.log(fmtKv('📡', 'Radar', `${now.radarId} — ${now.radarName}`, TERM.blue));
    console.log(fmtKv('🧭', 'Mode', now.mode, TERM.magenta));
    console.log(fmtKv('🧪', 'Frames', `${now.frames}`, TERM.magenta));
    console.log(hr());
    console.log(bold(`📍 ${entry.name}`));
    if (entry.error) {
      console.log(fmtKv('⚠️', 'Error', entry.error, TERM.yellow));
    } else {
      const rainLabel = entry.rainNow ? fmtStatus('raining', true) : fmtStatus('dry', false);
      console.log(fmtKv('🌧️', 'Status', rainLabel));
      if (!entry.rainNow && entry.etaMin === null) {
        console.log(fmtKv('✅', 'Forecast', noRainMessage()));
      } else {
        console.log(fmtKv('⏱️', 'ETA', formatEta(entry.etaMin, entry.etaWindowMin)));
        console.log(fmtKv('🎚️', 'Intensity', formatIntensity(entry.intensity)));
        console.log(fmtKv('✅', 'Confidence', formatConfidence(entry.confidence)));
      }
    }
    console.log('');
  }

  const outGif = path.join('/tmp', 'bom-nowcast-loop.gif');
  await renderLoopGif(chosen, DEFAULT_LOOP_FRAMES, outGif, cfg.locations || {}, cfg.cacheDays);

  if (!hasCommand('mpv')) {
    console.log(fmtKv('🎬', 'Player', 'mpv not found', TERM.yellow));
    console.log(fmtKv('📁', 'Loop', outGif, TERM.cyan));
    return;
  }

  const { spawn } = require('child_process');
  console.log(fmtKv('🎬', 'Player', 'opening mpv (looping)', TERM.green));
  console.log(fmtKv('📁', 'Loop', outGif, TERM.cyan));
  const mpvArgs = ['--loop=inf', '--no-terminal', '--quiet', outGif];
  const mpv = spawn('mpv', mpvArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => {
    mpv.on('exit', resolve);
    mpv.on('error', reject);
  });
}

async function renderCompositeFrame(radarId, framePath, locations = {}) {
  // Compose: background -> radar frame -> locations (place names) -> location emojis.
  const bg = await ensureOverlay(radarId, 'background');
  const loc = await ensureOverlay(radarId, 'locations');

  const radar = PNG.sync.read(fs.readFileSync(framePath));
  const out = new PNG({ width: radar.width, height: radar.height });
  out.data.fill(0);

  if (bg.width === out.width && bg.height === out.height) alphaOver(out, bg);
  alphaOver(out, radar);
  if (loc.width === out.width && loc.height === out.height) alphaOver(out, loc);

  const entries = Object.entries(locations || {});
  if (entries.length > 0) {
    const size = 14;
    const radar = RADARS[radarId];
    for (const [name, locEntry] of entries) {
      if (!locEntry || typeof locEntry.lat !== 'number' || typeof locEntry.lon !== 'number') continue;
      try {
        const { x, y } = latlonToPixel(radar, locEntry.lat, locEntry.lon, out.width, out.height);
        const emoji = resolveLocationEmoji(name, locEntry);
        const emojiPng = await ensureEmojiPng(emoji);
        const scaled = scalePng(emojiPng, size);
        alphaOverAt(out, scaled, x - Math.floor(size / 2), y - Math.floor(size / 2));
      } catch {
        // ignore locations outside radar bounds
      }
    }
  }

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

function computeGlobalCentroidVelocity(masks, w, dt) {
  const vxs = [];
  const vys = [];
  for (let i = 1; i < masks.length; i++) {
    const c0 = centroid(masks[i - 1], w);
    const c1 = centroid(masks[i], w);
    if (c0.n < 1000 || c1.n < 1000) continue;
    vxs.push((c1.cx - c0.cx) / dt);
    vys.push((c1.cy - c0.cy) / dt);
  }
  if (!vxs.length) return { vx: 0, vy: 0 };
  return {
    vx: vxs.reduce((a, b) => a + b, 0) / vxs.length,
    vy: vys.reduce((a, b) => a + b, 0) / vys.length,
  };
}

function computeMotionForTarget(masks, w, targetPixel, mode, fallbackVel) {
  const last = masks[masks.length - 1];
  const prev = masks[masks.length - 2];
  let box = bbox(last, w);
  if (mode === 'local' && targetPixel) {
    const { x: tx, y: ty } = targetPixel;
    const win = 140;
    const localBox = {
      minX: Math.max(0, tx - win),
      minY: Math.max(0, ty - win),
      maxX: Math.min(w - 1, tx + win),
      maxY: Math.min(w - 1, ty + win),
    };
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

  const shift = bestShift(prev, last, w, box, 20);
  const dt = 5;
  let vx = shift.dx / dt;
  let vy = shift.dy / dt;

  if (shift.score < 300 && fallbackVel) {
    vx = fallbackVel.vx;
    vy = fallbackVel.vy;
  }

  const speed = Math.sqrt(vx * vx + vy * vy);
  return { vx, vy, speed, shiftScore: shift.score };
}

async function nowcast(radarId, lat, lon, frames = 6, mode = 'local') {
  const results = await nowcastLocations(radarId, { Single: { lat, lon } }, frames, mode);
  return results.locations[0];
}

async function nowcastLocations(radarId, locations, frames = 6, mode = 'local') {
  const files = await ensureFrames(radarId, Math.max(frames, 2));
  const recent = files.slice(-frames);
  const imgs = [];
  for (const f of recent) imgs.push(await loadPng(f));

  const w = imgs[0].width;
  const radar = RADARS[radarId];
  const masks = imgs.map(precipMask);
  const lastMask = masks[masks.length - 1];
  const rainPixels = lastMask.reduce((a, b) => a + b, 0);

  const palette = await getLegendPalette();
  const bandMap = buildBandMap(imgs[imgs.length - 1], palette);

  const dt = 5;
  const fallbackVel = computeGlobalCentroidVelocity(masks, w, dt);

  const out = [];
  for (const [name, locEntry] of Object.entries(locations)) {
    if (!locEntry || typeof locEntry.lat !== 'number' || typeof locEntry.lon !== 'number') continue;
    let targetPixel = null;
    let kmPerPx = null;
    try {
      const px = latlonToPixel(radar, locEntry.lat, locEntry.lon, w, w);
      targetPixel = { x: px.x, y: px.y };
      kmPerPx = px.kmPerPx;
    } catch {
      out.push({
        name,
        lat: locEntry.lat,
        lon: locEntry.lon,
        error: 'outside radar bounds',
      });
      continue;
    }

    const motion = computeMotionForTarget(masks, w, targetPixel, mode, fallbackVel);
    const { vx, vy, speed, shiftScore } = motion;

    const idx = targetPixel.y * w + targetPixel.x;
    const rainNow = lastMask[idx] === 1;

    let etaMin = null;
    let etaWindowMin = null;
    let intensityBands = [];
    let candidateCount = 0;
    let spreadMin = null;
    let localCount = 0;

    if (rainNow) {
      intensityBands = sampleBandsRadius(bandMap, w, targetPixel.x, targetPixel.y, INTENSITY_RADIUS_PX);
      localCount = intensityBands.length;
      etaMin = 0;
      etaWindowMin = 0;
    } else if (rainPixels > 0 && speed > 0.1) {
      const { times, bands } = collectEtaCandidates(lastMask, bandMap, w, targetPixel.x, targetPixel.y, vx, vy, DEFAULT_ETA_MAX_MIN);
      candidateCount = times.length;
      if (times.length > 0) {
        const sorted = [...times].sort((a, b) => a - b);
        const p20 = percentile(sorted, 0.2);
        const p80 = percentile(sorted, 0.8);
        const med = median(sorted);
        etaMin = med;
        spreadMin = p20 !== null && p80 !== null ? (p80 - p20) : null;
        const window = spreadMin === null ? 0 : Math.round(spreadMin / 2);
        etaWindowMin = Math.max(2, window);
      }
      intensityBands = bands;
    }

    const intensity = intensityFromBands(intensityBands, palette.length);
    const spreadForConf = spreadMin === null ? 60 : spreadMin;
    let confidence = 0;
    if (rainNow) {
      const localQuality = clamp(localCount / 20, 0, 1);
      confidence = clamp(0.6 + 0.4 * localQuality, 0, 1);
    } else if (candidateCount > 0 && speed > 0.1) {
      const motionQuality = clamp(shiftScore / 800, 0, 1);
      const speedQuality = clamp(speed / 2.5, 0, 1);
      const countQuality = clamp(candidateCount / 400, 0, 1);
      const spreadQuality = 1 - clamp(spreadForConf / 30, 0, 1);
      confidence = clamp(
        0.35 * motionQuality + 0.25 * speedQuality + 0.25 * countQuality + 0.15 * spreadQuality,
        0,
        1
      );
    }

    out.push({
      name,
      lat: locEntry.lat,
      lon: locEntry.lon,
      targetPixel,
      kmPerPx,
      rainNow,
      rainPixels,
      etaMin,
      etaWindowMin,
      intensity,
      confidence,
      motionPxPerMin: { vx, vy },
      motionKmPerMin: { vx: vx * kmPerPx, vy: vy * kmPerPx },
      debug: { shiftScore, candidateCount },
    });
  }

  return {
    radarId,
    radarName: radar.name,
    mode,
    frames,
    locations: out,
  };
}

const program = new Command();
program
  .name('bom-nowcast')
  .description('BOM radar frame fetch + crude rain nowcast (Mt Stapylton primary, Marburg fallback)');

program
  .command('setup')
  .description('Interactive setup (radar + default location + emoji pins)')
  .action(async () => {
    await runSetup();
  });

program
  .command('radars')
  .description('List known radars')
  .action(() => {
    for (const [id, r] of Object.entries(RADARS)) {
      console.log(`${id}  ${r.name}`);
    }
  });

program
  .command('config-init')
  .description('Create default config file if missing (~/.config/bom-nowcast/config.json)')
  .action(() => {
    const existing = loadConfig();
    if (existing) {
      console.log(`Config already exists: ${configPath()}`);
      return;
    }
    const cfg = defaultConfig();
    saveConfig(cfg);
    console.log(`Wrote config: ${configPath()}`);
  });

program
  .command('locations')
  .description('List configured locations')
  .action(() => {
    const cfg = loadConfig() || defaultConfig();
    const def = cfg.defaultLocation;
    for (const [name, v] of Object.entries(cfg.locations || {})) {
      const mark = name === def ? '*' : ' ';
      const emoji = resolveLocationEmoji(name, v);
      console.log(`${mark} ${emoji} ${name}: ${v.lat}, ${v.lon}`);
    }
  });

program
  .command('location-add')
  .description('Add/update a named location in config')
  .requiredOption('--name <name>')
  .requiredOption('--lat <lat>')
  .requiredOption('--lon <lon>')
  .option('--emoji <emoji>', 'Optional emoji marker for this location')
  .option('--set-default', 'Also set as default location')
  .action((opts) => {
    const cfg = loadConfig() || defaultConfig();
    cfg.locations = cfg.locations || {};
    cfg.locations[opts.name] = {
      lat: parseFloat(opts.lat),
      lon: parseFloat(opts.lon),
      emoji: opts.emoji || cfg.locations[opts.name]?.emoji,
    };
    if (opts.setDefault) cfg.defaultLocation = opts.name;
    saveConfig(cfg);
    console.log(`Saved location ${opts.name} to ${configPath()}`);
  });

program
  .command('fetch')
  .description('Fetch latest radar frames into cache')
  .option('--radar <id>', 'Radar product id (IDR663/IDR503)', null)
  .option('--frames <n>', 'Number of frames', '10')
  .action(async (opts) => {
    const cfg = loadConfig() || defaultConfig();
    const preferred = opts.radar || cfg.defaultRadar || 'IDR663';
    const chosen = await pickRadar(preferred);
    const n = parseInt(opts.frames, 10);
    const files = await ensureFrames(chosen, n, cfg.cacheDays || DEFAULT_CACHE_DAYS);
    console.log(`radar: ${chosen} (${RADARS[chosen].name})`);
    console.log(`saved: ${files.length} frames -> ${path.join(cacheDir(), chosen)}`);
    console.log(`cache_prune_days: ${cfg.cacheDays || DEFAULT_CACHE_DAYS}`);
  });

program
  .command('loop')
  .description('Render a geographic-context loop GIF (background + frames + labels + location emojis)')
  .option('--radar <id>', 'Preferred radar (auto fallback)', null)
  .option('--frames <n>', 'Frames to include', '7')
  .option('--out <path>', 'Output gif path', '/tmp/bom-nowcast-loop.gif')
  .action(async (opts) => {
    const cfg = loadConfig() || defaultConfig();
    const preferred = opts.radar || cfg.defaultRadar || 'IDR663';
    const chosen = await pickRadar(preferred);
    const outGif = await renderLoopGif(chosen, opts.frames, opts.out, cfg.locations || {}, cfg.cacheDays);

    console.log(`radar: ${chosen} (${RADARS[chosen].name})`);
    console.log(`loop: ${outGif}`);
  });

program
  .command('nowcast')
  .description('Nowcast rain for a target lat/lon (or a named location from config)')
  .option('--lat <lat>')
  .option('--lon <lon>')
  .option('--location <name>', 'Location name from config (defaults to defaultLocation)')
  .option('--all', 'Nowcast for all configured locations')
  .option('--radar <id>', 'Preferred radar (auto fallback)', null)
  .option('--frames <n>', 'Frames to use', '6')
  .option('--mode <mode>', 'local|global motion estimate (default: local)', 'local')
  .action(async (opts) => {
    const cfg = loadConfig() || defaultConfig();
    const preferred = opts.radar || cfg.defaultRadar || 'IDR663';
    const chosen = await pickRadar(preferred);
    const n = parseInt(opts.frames, 10);
    const mode = opts.mode;

    let locations = {};
    const lat = opts.lat !== undefined ? parseFloat(opts.lat) : null;
    const lon = opts.lon !== undefined ? parseFloat(opts.lon) : null;

    if (lat !== null && lon !== null) {
      locations = { Custom: { lat, lon } };
    } else if (opts.all) {
      locations = cfg.locations || {};
    } else {
      const locName = opts.location || cfg.defaultLocation;
      const loc = getLocation(cfg, locName);
      if (!loc) throw new Error(`Unknown location: ${locName}. Run: node bom-nowcast.js locations`);
      locations = { [locName]: loc };
    }

    const r = await nowcastLocations(chosen, locations, n, mode);

    printLogo();
    console.log(bold('Nowcast'));
    console.log(fmtKv('📡', 'Radar', `${r.radarId} — ${r.radarName}`, TERM.blue));
    console.log(fmtKv('🧭', 'Mode', r.mode, TERM.magenta));
    console.log(fmtKv('🧪', 'Frames', `${r.frames}`, TERM.magenta));

    for (const loc of r.locations) {
      console.log(hr());
      console.log(bold(`📍 ${loc.name}`));
      if (loc.error) {
        console.log(fmtKv('⚠️', 'Error', loc.error, TERM.yellow));
        continue;
      }
      const rainLabel = loc.rainNow ? fmtStatus('raining', true) : fmtStatus('dry', false);
      console.log(fmtKv('🌧️', 'Status', rainLabel));
      if (!loc.rainNow && loc.etaMin === null) {
        console.log(fmtKv('✅', 'Forecast', noRainMessage()));
      } else {
        console.log(fmtKv('⏱️', 'ETA', formatEta(loc.etaMin, loc.etaWindowMin)));
        console.log(fmtKv('🎚️', 'Intensity', formatIntensity(loc.intensity)));
        console.log(fmtKv('✅', 'Confidence', formatConfidence(loc.confidence)));
      }
    }
  });

if (process.argv.length <= 2) {
  runDefault().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
} else {
  program.parseAsync(process.argv).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
