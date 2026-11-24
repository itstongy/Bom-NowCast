'use strict';

const fs = require('fs');
const path = require('path');
const { RADARS, orderedRadarsForLocation } = require('./radars');
const {
  DEFAULT_CACHE_DAYS,
  cacheDir,
  overlayDir,
  emojiDir,
  renderCacheDir,
  loopCacheDir,
  writeFileAtomic,
} = require('./config');
const { fetchBuffer, fetchText, mapConcurrent } = require('./http');
const { readPng } = require('./fast-png');

const SCRAPE_FRESH_MS = 45 * 1000;
const SCRAPE_MAX_SKIP_MS = 90 * 1000;
const STALE_FALLBACK_MAX_MS = 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_CONCURRENCY = 6;

const overlayCache = new Map();
const emojiCache = new Map();

function parseFrameTimestampMs(ts) {
  if (!ts || !/^\d{12}$/.test(ts)) return null;
  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10) - 1;
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(8, 10), 10);
  const min = parseInt(ts.slice(10, 12), 10);
  const ms = Date.UTC(year, month, day, hour, min);
  return Number.isFinite(ms) ? ms : null;
}

function parseFramesFromHtml(html) {
  const re = /theImageNames\[\d+\]\s*=\s*"(?<path>\/radar\/[^"]+?\.png)"/g;
  const seen = new Set();
  const uniq = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const p = m.groups.path;
    const url = `https://reg.bom.gov.au${p}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const tsMatch = p.match(/\.(\d{12})\./);
    const ts = tsMatch ? tsMatch[1] : null;
    uniq.push({
      url,
      ts,
      tsMs: parseFrameTimestampMs(ts),
      file: path.basename(p),
    });
  }
  return uniq;
}

async function scrapeFrames(radarId) {
  const radar = RADARS[radarId];
  if (!radar) throw new Error(`Unknown radar: ${radarId}`);
  const html = await fetchText(radar.loopUrl);
  return parseFramesFromHtml(html);
}

function scrapeMetaPath(radarId) {
  return path.join(cacheDir(), radarId, '.last-scrape.json');
}

function readScrapeMeta(radarId) {
  const p = scrapeMetaPath(radarId);
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || !Array.isArray(parsed.frames) || parsed.frames.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeScrapeMeta(radarId, frames) {
  try {
    writeFileAtomic(scrapeMetaPath(radarId), JSON.stringify({
      fetchedAt: Date.now(),
      radarId,
      frames,
    }));
  } catch {
    // non-fatal cache metadata write failure
  }
}

function estimateCadenceMs(frames) {
  const deltas = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].tsMs;
    const b = frames[i].tsMs;
    if (a && b && b > a && b - a <= 20 * 60 * 1000) {
      deltas.push(b - a);
    }
  }
  if (!deltas.length) return 5 * 60 * 1000;
  deltas.sort((x, y) => x - y);
  return deltas[Math.floor(deltas.length / 2)];
}

function canUseCachedScrape(radarId, count, meta) {
  if (!meta || !Array.isArray(meta.frames) || meta.frames.length < Math.min(count, 2)) {
    return false;
  }
  const now = Date.now();
  const ageMs = now - (meta.fetchedAt || 0);
  if (ageMs < 0) return false;

  // Ensure all required frames are actually cached on disk.
  const dir = path.join(cacheDir(), radarId);
  const chosen = meta.frames.slice(-count);
  for (const f of chosen) {
    if (!fs.existsSync(path.join(dir, f.file))) return false;
  }

  if (ageMs <= SCRAPE_FRESH_MS) return true;

  if (ageMs <= SCRAPE_MAX_SKIP_MS) {
    const latest = chosen[chosen.length - 1];
    if (latest && latest.tsMs) {
      const cadenceMs = estimateCadenceMs(chosen);
      // BOM publishes a scan roughly 60-90s after its timestamp.
      const nextDueMs = latest.tsMs + cadenceMs + 60 * 1000;
      if (now < nextDueMs) return true;
    }
  }
  return false;
}

/**
 * Pick a working radar and scrape its frame list in a single step (no extra HEAD probe).
 * Uses recent scrape cache when fresh unless opts.fresh is true.
 * Falls back to nearby radars covering targetLoc, or stale cache if offline.
 */
async function pickRadarAndScrape(preferred, targetLoc = null, opts = {}) {
  const count = opts.count || 7;
  const fresh = Boolean(opts.fresh);
  const candidates = orderedRadarsForLocation(preferred, targetLoc);

  if (!fresh && preferred && RADARS[preferred]) {
    const meta = readScrapeMeta(preferred);
    if (canUseCachedScrape(preferred, count, meta)) {
      return {
        radarId: preferred,
        frames: meta.frames,
        fromScrapeCache: true,
        staleFallback: false,
      };
    }
  }

  let lastErr = null;
  for (const id of candidates) {
    try {
      const frames = await scrapeFrames(id);
      if (frames.length >= 2) {
        writeScrapeMeta(id, frames);
        return {
          radarId: id,
          frames,
          fromScrapeCache: false,
          staleFallback: false,
        };
      }
    } catch (err) {
      lastErr = err;
    }
  }

  // Offline / transient BOM outage fallback: serve cached frames if reasonably recent.
  for (const id of candidates) {
    const meta = readScrapeMeta(id);
    if (!meta) continue;
    const ageMs = Date.now() - (meta.fetchedAt || 0);
    if (ageMs > STALE_FALLBACK_MAX_MS) continue;
    const dir = path.join(cacheDir(), id);
    const available = meta.frames.filter((f) => fs.existsSync(path.join(dir, f.file)));
    if (available.length >= 2) {
      return {
        radarId: id,
        frames: available,
        fromScrapeCache: true,
        staleFallback: true,
      };
    }
  }

  throw new Error(
    `No working radar among: ${candidates.join(', ')}${lastErr ? ` (${lastErr.message})` : ''}`
  );
}

function pruneDirByAge(dir, maxAgeDays, ext) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      pruneDirByAge(p, maxAgeDays, ext);
      continue;
    }
    if (ext && !ent.name.endsWith(ext)) continue;
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

function maybePruneCache(radarDir, maxAgeDays) {
  const marker = path.join(radarDir, '.last-prune');
  try {
    if (fs.existsSync(marker)) {
      const st = fs.statSync(marker);
      if (Date.now() - st.mtimeMs < PRUNE_INTERVAL_MS) return;
    }
  } catch {
    // proceed to prune
  }

  pruneDirByAge(radarDir, maxAgeDays, '.png');
  pruneDirByAge(renderCacheDir(), maxAgeDays, '.png');
  pruneDirByAge(loopCacheDir(), Math.min(maxAgeDays, 1), '.gif');

  try {
    fs.writeFileSync(marker, String(Date.now()));
  } catch {
    // ignore
  }
}

async function ensureFrames(radarId, count, opts = {}) {
  const cacheDays = opts.cacheDays || DEFAULT_CACHE_DAYS;
  const dir = path.join(cacheDir(), radarId);
  fs.mkdirSync(dir, { recursive: true });

  maybePruneCache(dir, cacheDays);

  let frames = opts.frames;
  if (!frames) {
    frames = await scrapeFrames(radarId);
    if (frames.length > 0) writeScrapeMeta(radarId, frames);
  }

  const chosen = frames.slice(-count);
  const missing = [];
  const results = chosen.map((f) => {
    const out = path.join(dir, f.file);
    const entry = { ...f, path: out };
    if (!fs.existsSync(out)) missing.push(entry);
    return entry;
  });

  if (missing.length > 0) {
    await mapConcurrent(missing, DEFAULT_CONCURRENCY, async (f) => {
      const data = await fetchBuffer(f.url);
      writeFileAtomic(f.path, data);
    });
  }

  return results;
}

async function ensureOverlay(radarId, feature) {
  const key = `${radarId}.${feature}`;
  if (overlayCache.has(key)) return overlayCache.get(key);

  const dir = overlayDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = `${radarId}.${feature}.png`;
  const out = path.join(dir, file);

  let buf;
  if (fs.existsSync(out)) {
    buf = fs.readFileSync(out);
  } else {
    const url = `https://reg.bom.gov.au/products/radar_transparencies/${file}`;
    buf = await fetchBuffer(url);
    writeFileAtomic(out, buf);
  }

  const png = readPng(buf);
  overlayCache.set(key, png);
  return png;
}

function emojiToCodepoints(emoji, stripFe0f = false) {
  const cps = Array.from(emoji).map((ch) => ch.codePointAt(0).toString(16));
  const filtered = stripFe0f ? cps.filter((cp) => cp !== 'fe0f') : cps;
  return filtered.join('-');
}

async function ensureEmojiPng(emoji) {
  if (emojiCache.has(emoji)) return emojiCache.get(emoji);

  const dir = emojiDir();
  fs.mkdirSync(dir, { recursive: true });

  // Twemoji drops FE0F when there is no ZWJ (200d); try canonical Twemoji filename first.
  const hasZwj = emoji.includes('\u200d');
  const primaryCode = emojiToCodepoints(emoji, !hasZwj);
  const fallbackCode = emojiToCodepoints(emoji, hasZwj);
  const candidates = primaryCode === fallbackCode ? [primaryCode] : [primaryCode, fallbackCode];

  for (const code of candidates) {
    const cached = path.join(dir, `${code}.png`);
    if (fs.existsSync(cached)) {
      const png = readPng(fs.readFileSync(cached));
      emojiCache.set(emoji, png);
      return png;
    }
  }

  let lastErr;
  for (const code of candidates) {
    const file = `${code}.png`;
    const out = path.join(dir, file);
    const url = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${file}`;
    try {
      const data = await fetchBuffer(url, { retries: 1 });
      writeFileAtomic(out, data);
      const png = readPng(data);
      emojiCache.set(emoji, png);
      return png;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error(`Failed to fetch emoji PNG for ${emoji}`);
}

module.exports = {
  parseFrameTimestampMs,
  parseFramesFromHtml,
  scrapeFrames,
  pickRadarAndScrape,
  ensureFrames,
  ensureOverlay,
  ensureEmojiPng,
  emojiToCodepoints,
};
