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

const execFileAsync = promisify(execFile);

const RENDER_VERSION = 'v2';
const DEFAULT_FRAME_DELAY_CS = 55; // 0.55s per historical frame
const DEFAULT_HOLD_DELAY_CS = 140; // 1.40s pause on the latest frame

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
    const outA = sa + ((da * invSa + 127) / 255) | 0;
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
      const outA = sa + ((da * invSa + 127) / 255) | 0;
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

/**
 * Prefetch and pre-bake the static background and top overlay (place names + scaled emojis)
 * once per (radarId, locations) combination so per-frame compositing only blends 2 layers.
 */
async function prepareStaticLayers(radarId, locations = {}) {
  const locHash = hashLocations(locations);
  const key = `${radarId}:${locHash}`;
  if (staticLayersCache.has(key)) return staticLayersCache.get(key);

  const radarMeta = RADARS[radarId];
  const entries = Object.entries(locations || {}).filter(
    ([, v]) => v && typeof v.lat === 'number' && typeof v.lon === 'number'
  );

  // Fetch overlays and all unique location emojis in parallel.
  const uniqueEmojis = [...new Set(entries.map(([name, loc]) => resolveLocationEmoji(name, loc)))];
  const [bg, locOverlay, emojiPngs] = await Promise.all([
    ensureOverlay(radarId, 'background'),
    ensureOverlay(radarId, 'locations'),
    Promise.all(
      uniqueEmojis.map((em) =>
        ensureEmojiPng(em).catch(() => null)
      )
    ),
  ]);

  const emojiByChar = new Map();
  for (let i = 0; i < uniqueEmojis.length; i++) {
    if (emojiPngs[i]) emojiByChar.set(uniqueEmojis[i], emojiPngs[i]);
  }

  // Bake locations overlay + emoji pins into a single reusable top layer.
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
    // Fast copy of opaque background instead of alpha-blending onto transparent zeros.
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

function buildDelaysCs(count, delayMs, holdMs) {
  const frameCs = Math.max(10, Math.round((delayMs ?? DEFAULT_FRAME_DELAY_CS * 10) / 10));
  const holdCs = Math.max(frameCs, Math.round((holdMs ?? DEFAULT_HOLD_DELAY_CS * 10) / 10));
  const delays = new Array(count).fill(frameCs);
  if (count > 0) delays[count - 1] = holdCs;
  return delays;
}

async function encodeGifWithFfmpeg(pngPaths, delaysCs, outGif) {
  const ffmpegBin = findExecutable('ffmpeg');
  if (!ffmpegBin) return false;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-ff-'));
  const listPath = path.join(tmpDir, 'frames.txt');
  const tmpGif = `${outGif}.${process.pid}.tmp.gif`;
  try {
    // Emit exactly N frames (1 per PNG) and patch exact per-frame GCE delays afterward.
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

function getLoopCachePath(radarId, frameEntries, locations = {}, opts = {}) {
  const locHash = hashLocations(locations);
  const delaysCs = buildDelaysCs(frameEntries.length, opts.delayMs, opts.holdMs);
  const framesSig = crypto
    .createHash('sha1')
    .update(`${RENDER_VERSION}|${radarId}|${locHash}|${delaysCs.join(',')}|${frameEntries.map((f) => f.file).join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return {
    locHash,
    delaysCs,
    cachedGifPath: path.join(loopCacheDir(), `${radarId}-${framesSig}.gif`),
  };
}

function hasCachedLoopGif(radarId, frameEntries, locations = {}, opts = {}) {
  if (opts.fresh || !frameEntries || frameEntries.length === 0) return false;
  const { cachedGifPath } = getLoopCachePath(radarId, frameEntries, locations, opts);
  return fs.existsSync(cachedGifPath);
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

async function renderLoopGifFromFrames(radarId, frameEntries, outGif, locations = {}, opts = {}) {
  if (!frameEntries || frameEntries.length === 0) {
    throw new Error('no radar frames available to render loop');
  }

  const { locHash, delaysCs, cachedGifPath } = getLoopCachePath(radarId, frameEntries, locations, opts);
  if (!opts.fresh && fs.existsSync(cachedGifPath)) {
    fs.mkdirSync(path.dirname(outGif), { recursive: true });
    if (path.resolve(cachedGifPath) !== path.resolve(outGif)) {
      fs.copyFileSync(cachedGifPath, outGif);
    }
    return { outGif, cacheHit: true };
  }

  const frameCacheDir = path.join(renderCacheDir(), `${RENDER_VERSION}-${radarId}-${locHash}`);
  fs.mkdirSync(frameCacheDir, { recursive: true });

  const decodedImgs = opts.decodedImgs || null;
  const renderedPaths = new Array(frameEntries.length);
  const missingIndices = [];

  for (let i = 0; i < frameEntries.length; i++) {
    const outPng = path.join(frameCacheDir, frameEntries[i].file);
    renderedPaths[i] = outPng;
    if (opts.fresh || !fs.existsSync(outPng)) {
      missingIndices.push(i);
    }
  }

  // Only prepare static layers & composite frames that are not already cached on disk.
  const compositedByIndex = new Map();
  if (missingIndices.length > 0) {
    const layers = opts.staticLayers || (await prepareStaticLayers(radarId, locations));
    for (const i of missingIndices) {
      const radarImg = decodedImgs && decodedImgs[i]
        ? decodedImgs[i]
        : readPngFile(frameEntries[i].path);
      const composite = compositeRadarFrame(radarImg, layers.bg, layers.top);
      compositedByIndex.set(i, composite);
      writeFileAtomic(renderedPaths[i], writePngFast(composite, 1));
    }
  }

  fs.mkdirSync(loopCacheDir(), { recursive: true });

  // Encode GIF via fastest available backend: ffmpeg -> magick/convert -> pure JS fallback.
  let encoded = false;
  try {
    encoded = await encodeGifWithFfmpeg(renderedPaths, delaysCs, cachedGifPath);
  } catch {
    encoded = false;
  }

  if (!encoded) {
    try {
      encoded = await encodeGifWithMagick(renderedPaths, delaysCs, cachedGifPath);
    } catch {
      encoded = false;
    }
  }

  if (!encoded) {
    const frames = renderedPaths.map((p, i) => compositedByIndex.get(i) || readPngFile(p));
    const gifBuf = encodeGif(frames, delaysCs);
    writeFileAtomic(cachedGifPath, gifBuf);
  }

  fs.mkdirSync(path.dirname(outGif), { recursive: true });
  if (path.resolve(cachedGifPath) !== path.resolve(outGif)) {
    fs.copyFileSync(cachedGifPath, outGif);
  }

  return { outGif, cacheHit: false, compositedCount: missingIndices.length };
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
  alphaOver,
  alphaOverAt,
  scalePng,
  prepareStaticLayers,
  compositeRadarFrame,
  hasCachedLoopGif,
  renderLoopGifFromFrames,
  renderLoopGif,
};
