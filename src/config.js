'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_CACHE_DAYS = 3;
const DEFAULT_LOOP_FRAMES = 7;
const DEFAULT_EMOJIS = [
  '🏠', '🏢', '🏫', '🏥', '🏖️', '🧭', '📍', '🌧️',
  '☂️', '🌤️', '⚡', '🚀', '⭐', '🧡', '💧', '🛰️',
];

function configPath() {
  return path.join(os.homedir(), '.config', 'bom-nowcast', 'config.json');
}

function cacheDir() {
  return path.join(os.homedir(), '.cache', 'bom-nowcast');
}

function overlayDir() {
  return path.join(cacheDir(), '_overlays');
}

function emojiDir() {
  return path.join(cacheDir(), '_emoji');
}

function renderCacheDir() {
  return path.join(cacheDir(), '_rendered');
}

function loopCacheDir() {
  return path.join(cacheDir(), '_loops');
}

function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
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
  writeFileAtomic(configPath(), JSON.stringify(cfg, null, 2) + '\n');
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

function hashLocations(locations) {
  const entries = Object.entries(locations || {})
    .filter(([, v]) => v && typeof v.lat === 'number' && typeof v.lon === 'number')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, v]) => [name, Number(v.lat.toFixed(6)), Number(v.lon.toFixed(6)), resolveLocationEmoji(name, v)]);
  return crypto.createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
}

function findExecutable(cmd) {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // continue searching PATH
    }
  }
  return null;
}

module.exports = {
  DEFAULT_CACHE_DAYS,
  DEFAULT_LOOP_FRAMES,
  DEFAULT_EMOJIS,
  configPath,
  cacheDir,
  overlayDir,
  emojiDir,
  renderCacheDir,
  loopCacheDir,
  writeFileAtomic,
  loadConfig,
  saveConfig,
  defaultConfig,
  getLocation,
  hashString,
  resolveLocationEmoji,
  hashLocations,
  findExecutable,
};
