'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { RADARS, latlonToPixel } = require('./radars');
const {
  DEFAULT_CACHE_DAYS,
  renderCacheDir,
  loopCacheDir,
  writeFileAtomic,
  resolveLocationEmoji,
  hashLocations,
  findExecutable,
} = require('./config');
const { ensureFrames, ensureOverlay, ensureEmojiPng } = require('./bom');
const { readPngFile, writePngFast } = require('./fast-png');
const { encodeGif, patchGifDelays } = require('./gif-encoder');
const { drawBadge, drawProgressBar } = require('./bitmap-font');

const execFileAsync = promisify(execFile);

const RENDER_VERSION = 'v3';
const DEFAULT_FRAME_DELAY_CS = 55;
const DEFAULT_HOLD_DELAY_CS = 140;
const FORECAST_LEADS_MIN = [10, 20, 30];
const BOM_HEADER_PX = 16;
const BOM_FOOTER_PX = 16;

// Fast RGBA alpha compositing: fast-paths transparent (0) and opaque (255) pixels.
function alphaOver(dst, src) {
  if (dst.width !== src.width || dst.height !== src.height) {
    throw new Error('overlay size mismatch');
  }
  const dd = dst.data;
  const sd = src.data;
  const len = dd.length;

  for (let i = 0; i < len; i += 4) {
    const sa = sd[i + 3];
    if (sa === 0) continue;
    if (sa === 255) {
      dd[i] = sd[i];
      dd[i + 1] = sd[i + 1];
      dd[i + 2] = sd[i + 2];
      dd[i + 3] = 255;
      continue;
    }

    const da = dd[i + 3];
    const invSa = 255 - sa;
    const outA = sa + (((da * invSa + 127) / 255) | 0);
    if (outA === 0) continue;

    const daTerm = (da * invSa) / 255;
    dd[i] = Math.round((sd[i] * sa + dd[i] * daTerm) / outA);
    dd[i + 1] = Math.round((sd[i + 1] * sa + dd[i + 1] * daTerm) / outA);
    dd[i + 2] = Math.round((sd[i + 2] * sa + dd[i + 2] * daTerm) / outA);
    dd[i + 3] = outA;
  }
}

function alphaOverAt(dst, src, x0, y0) {
  const dw = dst.width;
  const dh = dst.height;
  const sw = src.width;
  const sh = src.height;
  const dd = dst.data;
  const sd = src.data;

  for (let y = 0; y < sh; y++) {
    const yy = y0 + y;
    if (yy < 0 || yy >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const xx = x0 + x;
      if (xx < 0 || xx >= dw) continue;
      const si = (y * sw + x) << 2;
      const sa = sd[si + 3];
      if (sa === 0) continue;
      const di = (yy * dw + xx) << 2;

      if (sa === 255) {
        dd[di] = sd[si];
        dd[di + 1] = sd[si + 1];
        dd[di + 2] = sd[si + 2];
        dd[di + 3] = 255;
        continue;
      }

      const da = dd[di + 3];
      const invSa = 255 - sa;
      const outA = sa + (((da * invSa + 127) / 255) | 0);
      if (outA === 0) continue;

      const daTerm = (da * invSa) / 255;
      dd[di] = Math.round((sd[si] * sa + dd[di] * daTerm) / outA);
      dd[di + 1] = Math.round((sd[si + 1] * sa + dd[di + 1] * daTerm) / outA);
      dd[di + 2] = Math.round((sd[si + 2] * sa + dd[di + 2] * daTerm) / outA);
      dd[di + 3] = outA;
    }
  }
}

const scaledEmojiCache = new Map();

function scalePng(src, size, cacheKey) {
  if (cacheKey && scaledEmojiCache.has(cacheKey)) {
    return scaledEmojiCache.get(cacheKey);
  }
  const data = Buffer.allocUnsafe(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y / size) * src.height);
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x / size) * src.width);
      const si = (sy * src.width + sx) << 2;
      const di = (y * size + x) << 2;
      data[di] = src.data[si];
      data[di + 1] = src.data[si + 1];
      data[di + 2] = src.data[si + 2];
      data[di + 3] = src.data[si + 3];
    }
  }
  const out = { width: size, height: size, data };
  if (cacheKey) scaledEmojiCache.set(cacheKey, out);
  return out;
}

const staticLayersCache = new Map();

async function prepareStaticLayers(radarId, locations = {}) {
  const locHash = hashLocations(locations);
  const key = `${radarId}:${locHash}`;
  if (staticLayersCache.has(key)) return staticLayersCache.get(key);

  const radarMeta = RADARS[radarId];
  const entries = Object.entries(locations || {}).filter(
    ([, v]) => v && typeof v.lat === 'number' && typeof v.lon === 'number'
  );

  const uniqueEmojis = [...new Set(entries.map(([name, loc]) => resolveLocationEmoji(name, loc)))];
  const [bg, locOverlay, emojiPngs] = await Promise.all([
    ensureOverlay(radarId, 'background'),
    ensureOverlay(radarId, 'locations'),
    Promise.all(
      uniqueEmojis.map((em) => ensureEmojiPng(em).catch(() => null))
    ),
  ]);

  const emojiByChar = new Map();
  for (let i = 0; i < uniqueEmojis.length; i++) {
    if (emojiPngs[i]) emojiByChar.set(uniqueEmojis[i], emojiPngs[i]);
  }

  const top = {
    width: locOverlay.width,
    height: locOverlay.height,
    data: Buffer.from(locOverlay.data),
  };

  const pinSize = 14;
  for (const [name, locEntry] of entries) {
    try {
      const { x, y } = latlonToPixel(radarMeta, locEntry.lat, locEntry.lon, top.width, top.height);
      const emoji = resolveLocationEmoji(name, locEntry);
      const emojiPng = emojiByChar.get(emoji);
      if (!emojiPng) continue;
      const scaled = scalePng(emojiPng, pinSize, `${emoji}:${pinSize}`);
      alphaOverAt(top, scaled, x - Math.floor(pinSize / 2), y - Math.floor(pinSize / 2));
    } catch {
      // ignore locations outside radar bounds
    }
  }

  const layers = { bg, top, locHash };
  staticLayersCache.set(key, layers);
  return layers;
}

function compositeRadarFrame(radarImg, bg, top) {
  const w = radarImg.width;
  const h = radarImg.height;
  let data;
  if (bg.width === w && bg.height === h) {
    data = Buffer.from(bg.data);
  } else {
    data = Buffer.alloc(w * h * 4);
  }
  const out = { width: w, height: h, data };
  alphaOver(out, radarImg);
  if (top.width === w && top.height === h) {
    alphaOver(out, top);
  }
  return out;
}

/**
 * Create a projected radar layer by shifting precipitation pixels along (vx, vy) * leadMin.
 * Excludes BOM's static header/footer bars and dims alpha slightly to signal a forecast.
 */
function advectRadarFrame(lastRadarImg, vx, vy, leadMin) {
  const w = lastRadarImg.width;
  const h = lastRadarImg.height;
  const src = lastRadarImg.data;
  const dst = Buffer.alloc(w * h * 4);

  const dx = Math.round(vx * leadMin);
  const dy = Math.round(vy * leadMin);
  const yStart = h > BOM_HEADER_PX + BOM_FOOTER_PX ? BOM_HEADER_PX : 0;
  const yEnd = h > BOM_HEADER_PX + BOM_FOOTER_PX ? h - BOM_FOOTER_PX : h;

  // Keep BOM top copyright header bar only; omit stale UTC footer on forecast frames.
  if (yStart > 0) {
    src.copy(dst, 0, 0, yStart * w * 4);
  }

  for (let y = yStart; y < yEnd; y++) {
    const ny = y + dy;
    if (ny < yStart || ny >= yEnd) continue;
    for (let x = 0; x < w; x++) {
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      const si = (y * w + x) << 2;
      if (src[si + 3] === 0) continue;
      const r = src[si];
      const g = src[si + 1];
      const b = src[si + 2];
      // Skip greyscale borders/range rings from raw radar frame.
      if (r === g && g === b) continue;

      const di = (ny * w + nx) << 2;
      dst[di] = r;
      dst[di + 1] = g;
      dst[di + 2] = b;
      dst[di + 3] = 195; // ~76% opacity distinguishes projected forecast from live echoes
    }
  }

  return { width: w, height: h, data: dst };
}

function formatLocalTimeLabel(tsMs) {
  if (!tsMs) return '';
  const d = new Date(tsMs);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${suffix}`;
}

function shouldIncludeForecast(opts) {
  return opts.forecast !== false;
}

function resolveForecastVelocity(opts) {
  const m = opts.forecastMotion;
  if (!m || !m.motionReliable || (m.rainPixels || 0) < 40) {
    return { vx: 0, vy: 0 };
  }
  const vx = Number.isFinite(m.vx) ? m.vx : 0;
  const vy = Number.isFinite(m.vy) ? m.vy : 0;
  return { vx, vy };
}

function buildDelaysCs(historyCount, forecastCount, delayMs, holdMs) {
  const frameCs = Math.max(10, Math.round((delayMs ?? DEFAULT_FRAME_DELAY_CS * 10) / 10));
  const holdCs = Math.max(frameCs, Math.round((holdMs ?? DEFAULT_HOLD_DELAY_CS * 10) / 10));
  const delays = new Array(historyCount).fill(frameCs);
  if (forecastCount > 0) {
    // Pause briefly on NOW before flowing into projected forecast frames, then hold on final frame.
    if (historyCount > 0) delays[historyCount - 1] = Math.max(frameCs, Math.round(holdCs * 0.78));
    for (let i = 0; i < forecastCount; i++) {
      delays.push(i === forecastCount - 1 ? holdCs : Math.max(frameCs, Math.round(frameCs * 1.18)));
    }
  } else if (historyCount > 0) {
    delays[historyCount - 1] = holdCs;
  }
  return delays;
}

async function encodeGifWithFfmpeg(pngPaths, delaysCs, outGif) {
  const ffmpegBin = findExecutable('ffmpeg');
  if (!ffmpegBin) return false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-ff-'));
  const listPath = path.join(tmpDir, 'frames.txt');
  const tmpGif = `${outGif}.${process.pid}.tmp.gif`;
  try {
    const lines = [];
    for (let i = 0; i < pngPaths.length; i++) {
      const escaped = pngPaths[i].replace(/'/g, "'\\''");
      lines.push(`file '${escaped}'`);
    }
    fs.writeFileSync(listPath, lines.join('\n') + '\n');

    await execFileAsync(ffmpegBin, [
      '-y',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-fps_mode', 'passthrough',
      '-vf', 'split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=none',
      '-loop', '0',
      tmpGif,
    ]);

    const patched = patchGifDelays(fs.readFileSync(tmpGif), delaysCs);
    writeFileAtomic(outGif, patched);
    return true;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    try {
      fs.unlinkSync(tmpGif);
    } catch {
      // ignore
    }
  }
}

async function encodeGifWithMagick(pngPaths, delaysCs, outGif) {
  const bin = findExecutable('magick') || findExecutable('convert');
  if (!bin) return false;

  const tmpGif = `${outGif}.${process.pid}.tmp.gif`;
  try {
    const args = ['-loop', '0'];
    for (let i = 0; i < pngPaths.length; i++) {
      args.push('-delay', String(delaysCs[i]), pngPaths[i]);
    }
    args.push('-dither', 'None', '-colors', '128', tmpGif);
    await execFileAsync(bin, args);
    fs.renameSync(tmpGif, outGif);
    return true;
  } catch (err) {
    try {
      fs.unlinkSync(tmpGif);
    } catch {
      // ignore
    }
    throw err;
  }
}

function getLoopCachePath(radarId, frameEntries, locations = {}, opts = {}) {
  const locHash = hashLocations(locations);
  const useForecast = shouldIncludeForecast(opts);
  const forecastCount = useForecast ? FORECAST_LEADS_MIN.length : 0;
  const delaysCs = buildDelaysCs(frameEntries.length, forecastCount, opts.delayMs, opts.holdMs);
  const forecastVel = resolveForecastVelocity(opts);
  const motionKey = useForecast
    ? `fcst:${forecastVel.vx.toFixed(2)},${forecastVel.vy.toFixed(2)}`
    : 'nofcst';
  const tzOffset = new Date().getTimezoneOffset();
  const framesSig = crypto
    .createHash('sha1')
    .update(
      `${RENDER_VERSION}|${radarId}|${locHash}|${tzOffset}|${motionKey}|${delaysCs.join(',')}|${frameEntries.map((f) => f.file).join(',')}`
    )
    .digest('hex')
    .slice(0, 16);
  return {
    locHash,
    delaysCs,
    useForecast,
    forecastCount,
    cachedGifPath: path.join(loopCacheDir(), `${radarId}-${framesSig}.gif`),
  };
}

function hasCachedLoopGif(radarId, frameEntries, locations = {}, opts = {}) {
  if (opts.fresh || !frameEntries || frameEntries.length === 0) return false;
  const { cachedGifPath } = getLoopCachePath(radarId, frameEntries, locations, opts);
  return fs.existsSync(cachedGifPath);
}

async function renderLoopGifFromFrames(radarId, frameEntries, outGif, locations = {}, opts = {}) {
  if (!frameEntries || frameEntries.length === 0) {
    throw new Error('no radar frames available to render loop');
  }

  const { locHash, delaysCs, useForecast, forecastCount, cachedGifPath } = getLoopCachePath(
    radarId,
    frameEntries,
    locations,
    opts
  );

  if (!opts.fresh && fs.existsSync(cachedGifPath)) {
    fs.mkdirSync(path.dirname(outGif), { recursive: true });
    if (path.resolve(cachedGifPath) !== path.resolve(outGif)) {
      fs.copyFileSync(cachedGifPath, outGif);
    }
    return { outGif, cacheHit: true, forecastFrames: forecastCount };
  }

  const frameCacheDir = path.join(renderCacheDir(), `${RENDER_VERSION}-${radarId}-${locHash}`);
  fs.mkdirSync(frameCacheDir, { recursive: true });

  const decodedImgs = opts.decodedImgs || null;
  const basePaths = new Array(frameEntries.length);
  const missingBase = [];

  for (let i = 0; i < frameEntries.length; i++) {
    const outPng = path.join(frameCacheDir, frameEntries[i].file);
    basePaths[i] = outPng;
    if (opts.fresh || !fs.existsSync(outPng)) {
      missingBase.push(i);
    }
  }

  const needsLayers = missingBase.length > 0 || useForecast;
  const layers = needsLayers ? (opts.staticLayers || (await prepareStaticLayers(radarId, locations))) : null;

  // Build base composites (background + radar + labels + emojis) for uncached frames.
  const baseImgs = new Array(frameEntries.length);
  for (const i of missingBase) {
    const radarImg = decodedImgs && decodedImgs[i]
      ? decodedImgs[i]
      : readPngFile(frameEntries[i].path);
    const composite = compositeRadarFrame(radarImg, layers.bg, layers.top);
    baseImgs[i] = composite;
    writeFileAtomic(basePaths[i], writePngFast(composite, 1));
  }

  // Stamp local-time badges + 3px timeline progress bar + optional projected forecast frames.
  const totalCount = frameEntries.length + forecastCount;
  const tmpStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-stage-'));
  const stagedPaths = [];
  const stagedImgs = [];

  try {
    for (let i = 0; i < frameEntries.length; i++) {
      const base = baseImgs[i] || readPngFile(basePaths[i]);
      const img = { width: base.width, height: base.height, data: Buffer.from(base.data) };
      const isNow = i === frameEntries.length - 1;
      const localLabel = formatLocalTimeLabel(frameEntries[i].tsMs);
      if (localLabel) {
        drawBadge(img, isNow ? `${localLabel} NOW` : localLabel, {
          dotColor: isNow ? [74, 222, 128] : [56, 189, 248],
          borderColor: isNow ? [74, 222, 128, 170] : [211, 198, 170, 110],
        });
      }
      drawProgressBar(img, i, frameEntries.length, totalCount);

      const staged = path.join(tmpStageDir, `f-${String(i).padStart(2, '0')}.png`);
      fs.writeFileSync(staged, writePngFast(img, 1));
      stagedPaths.push(staged);
      stagedImgs.push(img);
    }

    if (useForecast) {
      const lastIdx = frameEntries.length - 1;
      const lastRadarImg = decodedImgs && decodedImgs[lastIdx]
        ? decodedImgs[lastIdx]
        : readPngFile(frameEntries[lastIdx].path);
      const lastTsMs = frameEntries[lastIdx].tsMs;
      const { vx, vy } = resolveForecastVelocity(opts);

      for (let f = 0; f < FORECAST_LEADS_MIN.length; f++) {
        const leadMin = FORECAST_LEADS_MIN[f];
        const advected = advectRadarFrame(lastRadarImg, vx, vy, leadMin);
        const img = compositeRadarFrame(advected, layers.bg, layers.top);
        const futureTime = lastTsMs ? formatLocalTimeLabel(lastTsMs + leadMin * 60000) : '';
        const label = futureTime ? `FCST +${leadMin}M ${futureTime}` : `FORECAST +${leadMin}M`;
        drawBadge(img, label, {
          dotColor: [245, 158, 11],
          borderColor: [245, 158, 11, 185],
          textColor: [254, 243, 199],
        });
        drawProgressBar(img, frameEntries.length + f, frameEntries.length, totalCount);

        const staged = path.join(tmpStageDir, `f-${String(frameEntries.length + f).padStart(2, '0')}.png`);
        fs.writeFileSync(staged, writePngFast(img, 1));
        stagedPaths.push(staged);
        stagedImgs.push(img);
      }
    }

    fs.mkdirSync(loopCacheDir(), { recursive: true });

    let encoded = false;
    try {
      encoded = await encodeGifWithFfmpeg(stagedPaths, delaysCs, cachedGifPath);
    } catch {
      encoded = false;
    }

    if (!encoded) {
      try {
        encoded = await encodeGifWithMagick(stagedPaths, delaysCs, cachedGifPath);
      } catch {
        encoded = false;
      }
    }

    if (!encoded) {
      const gifBuf = encodeGif(stagedImgs, delaysCs);
      writeFileAtomic(cachedGifPath, gifBuf);
    }
  } finally {
    fs.rmSync(tmpStageDir, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(outGif), { recursive: true });
  if (path.resolve(cachedGifPath) !== path.resolve(outGif)) {
    fs.copyFileSync(cachedGifPath, outGif);
  }

  return { outGif, cacheHit: false, compositedCount: missingBase.length, forecastFrames: forecastCount };
}

async function renderLoopGif(radarId, frameCount, outGif, locations = {}, opts = {}) {
  const n = parseInt(frameCount, 10);
  const frameEntries = await ensureFrames(radarId, n, {
    cacheDays: opts.cacheDays || DEFAULT_CACHE_DAYS,
    frames: opts.frames,
  });
  const recent = frameEntries.slice(-n);
  return renderLoopGifFromFrames(radarId, recent, outGif, locations, opts);
}

module.exports = {
  FORECAST_LEADS_MIN,
  alphaOver,
  alphaOverAt,
  scalePng,
  prepareStaticLayers,
  compositeRadarFrame,
  advectRadarFrame,
  formatLocalTimeLabel,
  hasCachedLoopGif,
  renderLoopGifFromFrames,
  renderLoopGif,
};
