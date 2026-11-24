'use strict';

const { RADARS, latlonToPixel } = require('./radars');
const { ensureFrames } = require('./bom');
const { readPngFile } = require('./fast-png');

const DEFAULT_ETA_MAX_MIN = 120;
const ETA_CROSS_PX = 20;
const INTENSITY_RADIUS_PX = 6;
const BOM_HEADER_PX = 16;
const BOM_FOOTER_PX = 16;
const TIMELINE_BUCKETS = 12; // 12 x 5 min = 60 min
const TIMELINE_STEP_MIN = 5;
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Exact BOM reflectivity palette ordered low -> high intensity (white = light rain, dark red/black = hail).
const INTENSITY_ORDER_HEX = [
  '#F5F5FF',
  '#B4B4FF',
  '#7878FF',
  '#1414FF',
  '#00D8C3',
  '#009690',
  '#006666',
  '#FFFF00',
  '#FFC800',
  '#FF9600',
  '#FF6400',
  '#FF0000',
  '#C80000',
  '#780000',
  '#280000',
];

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

const PALETTE_RGB = INTENSITY_ORDER_HEX.map(hexToRgb);
const EXACT_BAND_MAP = new Map();
for (let i = 0; i < PALETTE_RGB.length; i++) {
  const { r, g, b } = PALETTE_RGB[i];
  EXACT_BAND_MAP.set((r << 16) | (g << 8) | b, i);
}

function classifyIntensityBandRgb(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const cached = EXACT_BAND_MAP.get(key);
  if (cached !== undefined) return cached;

  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < PALETTE_RGB.length; i++) {
    const p = PALETTE_RGB[i];
    const dr = r - p.r;
    const dg = g - p.g;
    const db = b - p.b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  EXACT_BAND_MAP.set(key, bestI);
  return bestI;
}

function bandToLabel(band, bandCount = PALETTE_RGB.length) {
  if (bandCount <= 1) return 'unknown';
  const t = band / (bandCount - 1);
  if (t < 0.34) return 'light';
  if (t < 0.67) return 'moderate';
  if (t < 0.90) return 'heavy';
  return 'very heavy';
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
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

function bearingToCompass(deg) {
  const norm = ((deg % 360) + 360) % 360;
  return COMPASS_8[Math.round(norm / 45) % 8];
}

function vectorToBearingDeg(dxEast, dySouth) {
  return ((Math.atan2(dxEast, -dySouth) * 180) / Math.PI + 360) % 360;
}

/**
 * Single-pass precipitation extractor.
 * Excludes BOM's 16px top header and 16px bottom footer bars so text/borders never count as rain.
 * When computeBands is false, skips bandMap allocation for older frames used only for motion tracking.
 */
function extractPrecip(png, computeBands = false) {
  const w = png.width;
  const h = png.height;
  const data = png.data;
  const mask = new Uint8Array(w * h);
  const bandMap = computeBands ? new Int8Array(w * h).fill(-1) : null;
  let rainPixels = 0;

  const yStart = h > BOM_HEADER_PX + BOM_FOOTER_PX ? BOM_HEADER_PX : 0;
  const yEnd = h > BOM_HEADER_PX + BOM_FOOTER_PX ? h - BOM_FOOTER_PX : h;

  for (let y = yStart; y < yEnd; y++) {
    const rowIdx = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowIdx + x;
      const off = idx << 2;
      if (data[off + 3] === 0) continue;
      const r = data[off];
      const g = data[off + 1];
      const b = data[off + 2];
      // Greyscale pixels in raw BOM radar frames are range rings, borders, and text.
      if (r === g && g === b) continue;

      mask[idx] = 1;
      rainPixels++;
      if (bandMap) {
        bandMap[idx] = classifyIntensityBandRgb(r, g, b);
      }
    }
  }

  return { mask, bandMap, rainPixels };
}

function bbox(mask, w) {
  let minX = w;
  let minY = w;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < w; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
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

function downsampleMaskMax(mask, w, factor) {
  const cw = Math.ceil(w / factor);
  const out = new Uint8Array(cw * cw);
  for (let y = 0; y < w; y++) {
    const cyRow = Math.floor(y / factor) * cw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x]) {
        out[cyRow + Math.floor(x / factor)] = 1;
      }
    }
  }
  return { mask: out, w: cw };
}

/**
 * Coarse-to-fine + sparse active-pixel shift finder.
 * Finds (dx, dy) applied to mask0 that maximizes overlap with mask1 inside box.
 * 20x-100x faster than dense brute-force while matching its accuracy.
 */
function bestShift(mask0, mask1, w, box, maxShift = 20) {
  if (!box) return { dx: 0, dy: 0, score: 0 };

  // Collect active rain pixel coordinates from mask1 inside box.
  const activeX = [];
  const activeY = [];
  for (let y = box.minY; y <= box.maxY; y++) {
    const row = y * w;
    for (let x = box.minX; x <= box.maxX; x++) {
      if (mask1[row + x]) {
        activeX.push(x);
        activeY.push(y);
      }
    }
  }
  const nActive = activeX.length;
  if (nActive === 0) return { dx: 0, dy: 0, score: 0 };

  const ax = Int16Array.from(activeX);
  const ay = Int16Array.from(activeY);

  const scoreShift = (dx, dy) => {
    let score = 0;
    for (let i = 0; i < nActive; i++) {
      const x0 = ax[i] - dx;
      const y0 = ay[i] - dy;
      if (x0 >= 0 && x0 < w && y0 >= 0 && y0 < w) {
        score += mask0[y0 * w + x0];
      }
    }
    return score;
  };

  // For small rain patches, exact sparse search across all shifts takes < 2 ms.
  if (nActive <= 1200) {
    let best = { dx: 0, dy: 0, score: -1 };
    for (let dy = -maxShift; dy <= maxShift; dy++) {
      for (let dx = -maxShift; dx <= maxShift; dx++) {
        const s = scoreShift(dx, dy);
        if (s > best.score) best = { dx, dy, score: s };
      }
    }
    return best;
  }

  // Coarse 4x max-pooled pyramid search -> refine around top 4 peaks.
  const S = 4;
  const c0 = downsampleMaskMax(mask0, w, S);
  const c1 = downsampleMaskMax(mask1, w, S);
  const cw = c0.w;
  const cBox = {
    minX: Math.floor(box.minX / S),
    minY: Math.floor(box.minY / S),
    maxX: Math.min(cw - 1, Math.floor(box.maxX / S)),
    maxY: Math.min(cw - 1, Math.floor(box.maxY / S)),
  };

  const cax = [];
  const cay = [];
  for (let y = cBox.minY; y <= cBox.maxY; y++) {
    const row = y * cw;
    for (let x = cBox.minX; x <= cBox.maxX; x++) {
      if (c1.mask[row + x]) {
        cax.push(x);
        cay.push(y);
      }
    }
  }
  const cMax = Math.ceil(maxShift / S);
  const coarseCandidates = [];
  for (let dy = -cMax; dy <= cMax; dy++) {
    for (let dx = -cMax; dx <= cMax; dx++) {
      let s = 0;
      for (let i = 0; i < cax.length; i++) {
        const x0 = cax[i] - dx;
        const y0 = cay[i] - dy;
        if (x0 >= 0 && x0 < cw && y0 >= 0 && y0 < cw) {
          s += c0.mask[y0 * cw + x0];
        }
      }
      coarseCandidates.push({ dx: dx * S, dy: dy * S, s });
    }
  }
  coarseCandidates.sort((a, b) => b.s - a.s);

  const span = maxShift * 2 + 1;
  const visited = new Uint8Array(span * span);
  let best = { dx: 0, dy: 0, score: -1 };

  const evalCandidate = (dx, dy) => {
    if (dx < -maxShift || dx > maxShift || dy < -maxShift || dy > maxShift) return;
    const vi = (dy + maxShift) * span + (dx + maxShift);
    if (visited[vi]) return;
    visited[vi] = 1;
    const s = scoreShift(dx, dy);
    if (s > best.score) best = { dx, dy, score: s };
  };

  const peaks = coarseCandidates.slice(0, 4);
  for (const peak of peaks) {
    for (let oy = -S; oy <= S; oy++) {
      for (let ox = -S; ox <= S; ox++) {
        evalCandidate(peak.dx + ox, peak.dy + oy);
      }
    }
  }
  // Always check zero shift as baseline.
  evalCandidate(0, 0);

  return best;
}

function centroid(mask, w) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < w; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  if (n === 0) return { cx: 0, cy: 0, n: 0 };
  return { cx: sx / n, cy: sy / n, n };
}

function computeFrameDeltaMin(frame0, frame1) {
  if (frame0 && frame1 && frame0.tsMs && frame1.tsMs) {
    const dt = (frame1.tsMs - frame0.tsMs) / 60000;
    if (dt > 0.5 && dt <= 30) return dt;
  }
  return 5;
}

function computeGlobalCentroidVelocity(masks, frames, w) {
  const centroids = masks.map((m) => centroid(m, w));
  const vxs = [];
  const vys = [];
  for (let i = 1; i < centroids.length; i++) {
    const c0 = centroids[i - 1];
    const c1 = centroids[i];
    if (c0.n < 400 || c1.n < 400) continue;
    // Reject pairs where rain area changed drastically (new cell popping up shifts centroid artificially).
    const ratio = c1.n / c0.n;
    if (ratio < 0.6 || ratio > 1.67) continue;
    const dt = computeFrameDeltaMin(frames[i - 1], frames[i]);
    vxs.push((c1.cx - c0.cx) / dt);
    vys.push((c1.cy - c0.cy) / dt);
  }
  if (!vxs.length) return { vx: 0, vy: 0 };
  vxs.sort((a, b) => a - b);
  vys.sort((a, b) => a - b);
  return {
    vx: median(vxs),
    vy: median(vys),
  };
}

function countRainInBox(mask, w, box) {
  if (!box) return 0;
  let n = 0;
  for (let y = box.minY; y <= box.maxY; y++) {
    const row = y * w;
    for (let x = box.minX; x <= box.maxX; x++) {
      if (mask[row + x]) n++;
    }
  }
  return n;
}

function computeMotionBox(lastMask, lastBbox, w, targetPixel, mode) {
  let box = lastBbox;
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
      const inter = {
        minX: Math.max(localBox.minX, box.minX),
        minY: Math.max(localBox.minY, box.minY),
        maxX: Math.min(localBox.maxX, box.maxX),
        maxY: Math.min(localBox.maxY, box.maxY),
      };
      if (inter.minX <= inter.maxX && inter.minY <= inter.maxY && countRainInBox(lastMask, w, inter) >= 200) {
        box = inter;
      }
      // Otherwise keep the full rain bounding box so distant showers still track cleanly.
    } else {
      box = localBox;
    }
  }
  return expandBox(box, w, 10);
}

/**
 * Multi-frame median motion tracker across up to the last 3 consecutive frame pairs
 * using actual UTC timestamp deltas.
 */
function computeMotionForTarget(masks, frames, lastBbox, w, targetPixel, mode, getFallbackVel) {
  const last = masks[masks.length - 1];
  let box = computeMotionBox(last, lastBbox, w, targetPixel, mode);
  const pairEnd = masks.length - 1;
  const pairStart = Math.max(1, masks.length - 3);

  const trackInBox = (searchBox) => {
    const valid = [];
    let latestScore = 0;
    for (let i = pairStart; i <= pairEnd; i++) {
      const dt = computeFrameDeltaMin(frames[i - 1], frames[i]);
      const shift = bestShift(masks[i - 1], masks[i], w, searchBox, 20);
      if (i === pairEnd) latestScore = shift.score;
      if (shift.score >= 150) {
        valid.push({
          vx: shift.dx / dt,
          vy: shift.dy / dt,
          score: shift.score,
        });
      }
    }
    return { valid, latestScore };
  };

  let { valid, latestScore } = trackInBox(box);

  // If local window had weak overlap, widen once to the full rain bounding box before falling back to centroid.
  if (valid.length === 0 && mode === 'local' && lastBbox) {
    const globalBox = expandBox(lastBbox, w, 10);
    if (
      !box ||
      globalBox.minX !== box.minX ||
      globalBox.minY !== box.minY ||
      globalBox.maxX !== box.maxX ||
      globalBox.maxY !== box.maxY
    ) {
      box = globalBox;
      ({ valid, latestScore } = trackInBox(box));
    }
  }

  let vx = 0;
  let vy = 0;
  let shiftScore = latestScore;
  let motionReliable = false;

  if (valid.length >= 2) {
    const vxs = valid.map((v) => v.vx).sort((a, b) => a - b);
    const vys = valid.map((v) => v.vy).sort((a, b) => a - b);
    vx = median(vxs);
    vy = median(vys);
    shiftScore = Math.max(latestScore, Math.round(valid.reduce((s, v) => s + v.score, 0) / valid.length));
    motionReliable = true;
  } else if (valid.length === 1 && valid[0].score >= 250) {
    vx = valid[0].vx;
    vy = valid[0].vy;
    shiftScore = valid[0].score;
    motionReliable = true;
  } else {
    const fb = getFallbackVel();
    vx = fb.vx;
    vy = fb.vy;
  }

  const speed = Math.hypot(vx, vy);
  return { vx, vy, speed, shiftScore, motionReliable };
}

function intensityFromBands(bands, paletteCount = PALETTE_RGB.length) {
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
  const y0 = Math.max(0, ty - radiusPx);
  const y1 = Math.min(w - 1, ty + radiusPx);
  const x0 = Math.max(0, tx - radiusPx);
  const x1 = Math.min(w - 1, tx + radiusPx);
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    const dy = y - ty;
    for (let x = x0; x <= x1; x++) {
      const dx = x - tx;
      if (dx * dx + dy * dy > r2) continue;
      const band = bandMap[row + x];
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

  for (let y = 0; y < w; y++) {
    const row = y * w;
    const dy = ty - y;
    for (let x = 0; x < w; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      const dx = tx - x;
      const dot = dx * vx + dy * vy;
      if (dot <= 0) continue;
      const t = dot / v2;
      if (t > maxEta) continue;
      const cross = Math.abs(dx * vy - dy * vx) / vMag;
      if (cross > ETA_CROSS_PX) continue;
      times.push(t);
      const band = bandMap[idx];
      if (band >= 0) bands.push(band);
    }
  }
  return { times, bands };
}

/**
 * When already raining at target, march upstream along (-vx, -vy) in 1-minute steps
 * to estimate when the current rain band finishes passing over the target.
 */
function estimateClearEtaMin(mask, w, tx, ty, vx, vy, maxMin = 90) {
  const speed = Math.hypot(vx, vy);
  if (speed < 0.15) return null;

  let lastRainMin = 0;
  let dryStreak = 0;
  const sampleR = 3;

  for (let t = 1; t <= maxMin; t++) {
    const ux = Math.round(tx - vx * t);
    const uy = Math.round(ty - vy * t);
    if (ux < 0 || uy < 0 || ux >= w || uy >= w) return null;

    let hit = false;
    for (let oy = -sampleR; oy <= sampleR && !hit; oy++) {
      const yy = uy + oy;
      if (yy < 0 || yy >= w) continue;
      const row = yy * w;
      for (let ox = -sampleR; ox <= sampleR; ox++) {
        const xx = ux + ox;
        if (xx >= 0 && xx < w && mask[row + xx]) {
          hit = true;
          break;
        }
      }
    }

    if (hit) {
      lastRainMin = t;
      dryStreak = 0;
    } else {
      dryStreak++;
      if (dryStreak >= 4) {
        return Math.max(1, lastRainMin + 1);
      }
    }
  }
  return null;
}

function findNearestRain(mask, w, tx, ty, kmPerPx) {
  let bestD2 = Infinity;
  let bestDx = 0;
  let bestDy = 0;
  for (let y = 0; y < w; y++) {
    const row = y * w;
    const dy = y - ty;
    const dy2 = dy * dy;
    if (dy2 >= bestD2) continue;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      const dx = x - tx;
      const d2 = dx * dx + dy2;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  if (!Number.isFinite(bestD2)) return null;
  const km = Math.sqrt(bestD2) * kmPerPx;
  const bearing = vectorToBearingDeg(bestDx, bestDy);
  return {
    km: Math.round(km * 10) / 10,
    bearingDeg: Math.round(bearing),
    dir: bearingToCompass(bearing),
  };
}

/**
 * Project upstream rain along (-vx, -vy) into 12 x 5-minute buckets (0..60 min).
 * Each bucket holds the p80 reflectivity band (-1 = dry, 0..14 = BOM band).
 */
function buildTimeline60m(bandMap, w, tx, ty, vx, vy, rainNow, motionReliable) {
  const buckets = new Array(TIMELINE_BUCKETS).fill(-1);
  const speed = Math.hypot(vx, vy);
  const canProject = motionReliable && speed >= 0.1;

  for (let b = 0; b < TIMELINE_BUCKETS; b++) {
    const samples = [];
    if (b === 0 && rainNow) {
      const local = sampleBandsRadius(bandMap, w, tx, ty, INTENSITY_RADIUS_PX);
      for (const s of local) samples.push(s);
    }

    if (canProject) {
      const tStart = b * TIMELINE_STEP_MIN;
      // Sample 3 sub-steps inside each 5-minute bucket to avoid skipping narrow rain bands.
      const subSteps = [tStart + 0.5, tStart + 2.5, tStart + 4.5];
      for (const t of subSteps) {
        const ux = Math.round(tx - vx * t);
        const uy = Math.round(ty - vy * t);
        if (ux < 0 || uy < 0 || ux >= w || uy >= w) continue;
        const local = sampleBandsRadius(bandMap, w, ux, uy, 5);
        for (const s of local) samples.push(s);
      }
    }

    if (samples.length > 0) {
      samples.sort((a, b2) => a - b2);
      buckets[b] = Math.round(percentile(samples, 0.75));
    }
  }

  return buckets;
}

function bandToSparkChar(band, bandCount = PALETTE_RGB.length) {
  if (band === null || band === undefined || band < 0) return '·';
  const idx = clamp(Math.floor((band / Math.max(1, bandCount - 1)) * (SPARK_CHARS.length - 1)), 0, SPARK_CHARS.length - 1);
  return SPARK_CHARS[idx];
}

function timelineToSparkline(timeline60m) {
  return timeline60m.map((b) => bandToSparkChar(b)).join('');
}

/**
 * Compare intensity of the relevant rain cell between an earlier frame and the latest frame
 * to detect whether approaching/overhead rain is building, steady, or easing.
 */
function estimateIntensityTrend(prevImg, lastBandMap, w, tx, ty, vx, vy, dtMin, rainNow, etaMin) {
  if (!prevImg || !lastBandMap || !Number.isFinite(dtMin) || dtMin <= 0) return null;
  const focusT = rainNow ? 0 : (etaMin !== null ? etaMin : null);
  if (focusT === null) return null;

  const nowX = Math.round(tx - vx * focusT);
  const nowY = Math.round(ty - vy * focusT);
  const prevX = Math.round(nowX - vx * dtMin);
  const prevY = Math.round(nowY - vy * dtMin);

  if (nowX < 0 || nowY < 0 || nowX >= w || nowY >= w) return null;
  if (prevX < 0 || prevY < 0 || prevX >= w || prevY >= w) return null;

  const r = 18;
  const nowBands = sampleBandsRadius(lastBandMap, w, nowX, nowY, r);
  if (nowBands.length < 10) return null;

  // Sample bands directly from prevImg pixels in radius r around (prevX, prevY).
  const prevBands = [];
  const data = prevImg.data;
  const r2 = r * r;
  const y0 = Math.max(BOM_HEADER_PX, prevY - r);
  const y1 = Math.min(w - BOM_FOOTER_PX - 1, prevY + r);
  const x0 = Math.max(0, prevX - r);
  const x1 = Math.min(w - 1, prevX + r);
  for (let y = y0; y <= y1; y++) {
    const dy = y - prevY;
    for (let x = x0; x <= x1; x++) {
      const dx = x - prevX;
      if (dx * dx + dy * dy > r2) continue;
      const off = (y * w + x) << 2;
      if (data[off + 3] === 0) continue;
      const red = data[off];
      const green = data[off + 1];
      const blue = data[off + 2];
      if (red === green && green === blue) continue;
      prevBands.push(classifyIntensityBandRgb(red, green, blue));
    }
  }
  if (prevBands.length < 10) return null;

  nowBands.sort((a, b) => a - b);
  prevBands.sort((a, b) => a - b);
  const nowP75 = percentile(nowBands, 0.75);
  const prevP75 = percentile(prevBands, 0.75);
  const delta = nowP75 - prevP75;

  if (delta >= 1.5) return 'building';
  if (delta <= -1.5) return 'easing';
  return 'steady';
}

/**
 * Run nowcast directly on already-fetched frames (and optionally already-decoded PNGs)
 * to avoid duplicate disk reads and PNG decodes when paired with loop rendering.
 */
function nowcastFromFrames(radarId, locations, frameEntries, opts = {}) {
  const mode = opts.mode || 'local';
  const decodedImgs = opts.decodedImgs || null;
  const frames = frameEntries;
  if (!frames || frames.length < 2) {
    throw new Error('need at least 2 radar frames for nowcast');
  }

  // Motion uses up to the last 4 frames (3 frame pairs); lazy centroid fallback decodes earlier ones only if needed.
  const motionCount = Math.min(frames.length, 4);
  const motionStartIdx = frames.length - motionCount;

  const imgs = new Array(frames.length);
  const masks = new Array(frames.length);
  let lastBandMap = null;
  let rainPixels = 0;

  for (let i = motionStartIdx; i < frames.length; i++) {
    const isLast = i === frames.length - 1;
    const img = decodedImgs && decodedImgs[i] ? decodedImgs[i] : readPngFile(frames[i].path);
    imgs[i] = img;
    const ext = extractPrecip(img, isLast);
    masks[i] = ext.mask;
    if (isLast) {
      lastBandMap = ext.bandMap;
      rainPixels = ext.rainPixels;
    }
  }

  const w = imgs[frames.length - 1].width;
  const radar = RADARS[radarId];
  const lastMask = masks[frames.length - 1];
  const lastBbox = rainPixels > 0 ? bbox(lastMask, w) : null;

  const motionMasks = masks.slice(motionStartIdx);
  const motionFrames = frames.slice(motionStartIdx);

  let cachedFallbackVel = null;
  const getFallbackVel = () => {
    if (cachedFallbackVel) return cachedFallbackVel;
    // Decode any earlier frames lazily only if shift tracking fails.
    for (let i = 0; i < motionStartIdx; i++) {
      if (!masks[i]) {
        const img = decodedImgs && decodedImgs[i] ? decodedImgs[i] : readPngFile(frames[i].path);
        imgs[i] = img;
        masks[i] = extractPrecip(img, false).mask;
      }
    }
    cachedFallbackVel = computeGlobalCentroidVelocity(masks, frames, w);
    return cachedFallbackVel;
  };

  let cachedGlobalMotion = null;
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

    let motion;
    if (rainPixels === 0) {
      motion = { vx: 0, vy: 0, speed: 0, shiftScore: 0, motionReliable: false };
    } else if (mode === 'global') {
      if (!cachedGlobalMotion) {
        cachedGlobalMotion = computeMotionForTarget(motionMasks, motionFrames, lastBbox, w, null, 'global', getFallbackVel);
      }
      motion = cachedGlobalMotion;
    } else {
      motion = computeMotionForTarget(motionMasks, motionFrames, lastBbox, w, targetPixel, 'local', getFallbackVel);
    }

    const { vx, vy, speed, shiftScore, motionReliable } = motion;
    const idx = targetPixel.y * w + targetPixel.x;
    const rainNow = lastMask[idx] === 1;

    let etaMin = null;
    let etaWindowMin = null;
    let clearEtaMin = null;
    let nearestRain = null;
    let intensityBands = [];
    let candidateCount = 0;
    let spreadMin = null;
    let localCount = 0;

    if (rainNow) {
      intensityBands = sampleBandsRadius(lastBandMap, w, targetPixel.x, targetPixel.y, INTENSITY_RADIUS_PX);
      localCount = intensityBands.length;
      etaMin = 0;
      etaWindowMin = 0;
      clearEtaMin = estimateClearEtaMin(lastMask, w, targetPixel.x, targetPixel.y, vx, vy);
    } else if (rainPixels > 0) {
      if (speed > 0.1) {
        const { times, bands } = collectEtaCandidates(lastMask, lastBandMap, w, targetPixel.x, targetPixel.y, vx, vy, DEFAULT_ETA_MAX_MIN);
        candidateCount = times.length;
        if (times.length > 0) {
          const sorted = [...times].sort((a, b) => a - b);
          const p20 = percentile(sorted, 0.2);
          const p80 = percentile(sorted, 0.8);
          etaMin = median(sorted);
          spreadMin = p20 !== null && p80 !== null ? p80 - p20 : null;
          const win = spreadMin === null ? 0 : Math.round(spreadMin / 2);
          etaWindowMin = Math.max(2, win);
        }
        intensityBands = bands;
      }
      nearestRain = findNearestRain(lastMask, w, targetPixel.x, targetPixel.y, kmPerPx);
    }

    const intensity = intensityFromBands(intensityBands, PALETTE_RGB.length);
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

    const motionKmh = motionReliable || speed > 0.1 ? Math.round(speed * kmPerPx * 60) : 0;
    const motionDir = (motionReliable && speed > 0.1) ? bearingToCompass(vectorToBearingDeg(vx, vy)) : null;

    const timeline60m = buildTimeline60m(lastBandMap, w, targetPixel.x, targetPixel.y, vx, vy, rainNow, motionReliable);
    const sparkline = timelineToSparkline(timeline60m);

    // Compare against 2 frames ago (~10 min earlier) when available for a stable trend.
    const trendRefIdx = Math.max(motionStartIdx, frames.length - 3);
    const trendDt = trendRefIdx < frames.length - 1
      ? (frames[frames.length - 1].tsMs && frames[trendRefIdx].tsMs
        ? (frames[frames.length - 1].tsMs - frames[trendRefIdx].tsMs) / 60000
        : (frames.length - 1 - trendRefIdx) * 5)
      : 0;
    const intensityTrend = (rainNow || etaMin !== null)
      ? estimateIntensityTrend(imgs[trendRefIdx], lastBandMap, w, targetPixel.x, targetPixel.y, vx, vy, trendDt, rainNow, etaMin)
      : null;

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
      clearEtaMin,
      nearestRain,
      intensity,
      intensityTrend,
      timeline60m,
      sparkline,
      confidence,
      motionKmh,
      motionDir,
      motionReliable,
      motionPxPerMin: { vx, vy },
      motionKmPerMin: { vx: vx * kmPerPx, vy: vy * kmPerPx },
      debug: { shiftScore, candidateCount },
    });
  }

  const latestFrame = frames[frames.length - 1];
  const latestFrameTsMs = latestFrame ? latestFrame.tsMs : null;
  const dataAgeMin = latestFrameTsMs ? Math.max(0, Math.round((Date.now() - latestFrameTsMs) / 60000)) : null;

  return {
    radarId,
    radarName: radar.name,
    mode,
    frames: frames.length,
    latestFrameTs: latestFrame ? latestFrame.ts : null,
    latestFrameIso: latestFrameTsMs ? new Date(latestFrameTsMs).toISOString() : null,
    dataAgeMin,
    staleFallback: Boolean(opts.staleFallback),
    locations: out,
    _decodedImgs: imgs,
  };
}

async function nowcastLocations(radarId, locations, framesCount = 6, mode = 'local', opts = {}) {
  const frameEntries = await ensureFrames(radarId, Math.max(framesCount, 2), opts);
  const recent = frameEntries.slice(-framesCount);
  return nowcastFromFrames(radarId, locations, recent, { mode, staleFallback: opts.staleFallback });
}

module.exports = {
  INTENSITY_ORDER_HEX,
  PALETTE_RGB,
  classifyIntensityBandRgb,
  bandToLabel,
  extractPrecip,
  bestShift,
  computeFrameDeltaMin,
  estimateClearEtaMin,
  findNearestRain,
  buildTimeline60m,
  bandToSparkChar,
  timelineToSparkline,
  estimateIntensityTrend,
  nowcastFromFrames,
  nowcastLocations,
};
