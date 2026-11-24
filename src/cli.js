'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { stdin: input, stdout: output } = require('process');
const { Command } = require('commander');

const { RADARS } = require('./radars');
const {
  DEFAULT_CACHE_DAYS,
  DEFAULT_LOOP_FRAMES,
  DEFAULT_EMOJIS,
  configPath,
  cacheDir,
  writeFileAtomic,
  loadConfig,
  saveConfig,
  defaultConfig,
  getLocation,
  resolveLocationEmoji,
  findExecutable,
} = require('./config');
const { pickRadarAndScrape, ensureFrames } = require('./bom');
const { nowcastFromFrames, bandToSparkChar } = require('./nowcast');
const { prepareStaticLayers, hasCachedLoopGif, renderLoopGifFromFrames } = require('./render');

const DEFAULT_NOTIFY_THRESHOLD_MIN = 30;
const DEFAULT_NOTIFY_COOLDOWN_MIN = 45;

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
  return Math.max(56, Math.min(w, 120));
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
  if (widest + 2 > w) {
    console.log(bold(colorize(TERM.cyan, 'BOM NOWCAST')) + dim(' • live radar & rain ETA'));
    console.log(hr());
    return;
  }
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

function formatIntensity(intensity, trend) {
  if (!intensity) return colorize(TERM.dim, 'none');
  const likely = intensity.likelyLabel || 'none';
  const peak = intensity.peakLabel || 'none';
  const extras = [];
  if (likely !== peak && peak !== 'none') extras.push(`peak ${peak}`);
  if (trend && trend !== 'steady') extras.push(trend);
  const suffix = extras.length > 0 ? ` ${dim(`(${extras.join(', ')})`)}` : '';
  return `${colorize(TERM.yellow, likely)}${suffix}`;
}

function formatConfidence(confidence) {
  const pct = Math.round((confidence || 0) * 100);
  const color = pct >= 70 ? TERM.green : pct >= 40 ? TERM.yellow : TERM.red;
  return colorize(color, `${pct}%`);
}

function formatDataAge(ageMin, staleFallback) {
  if (ageMin === null || ageMin === undefined) return dim('unknown');
  const text = ageMin <= 1 ? 'just now' : `${ageMin} min ago`;
  if (staleFallback) return colorize(TERM.yellow, `${text} (cached, offline)`);
  if (ageMin > 15) return colorize(TERM.yellow, `${text} (stale)`);
  return colorize(TERM.green, text);
}

function formatSparkline(timeline60m) {
  if (!Array.isArray(timeline60m) || timeline60m.length === 0) return null;
  const hasAny = timeline60m.some((b) => b >= 0);
  if (!hasAny) return null;
  const bar = timeline60m
    .map((band) => {
      const ch = bandToSparkChar(band);
      if (band < 0) return dim(ch);
      if (band <= 3) return colorize(TERM.cyan, ch);
      if (band <= 6) return colorize(TERM.green, ch);
      if (band <= 10) return colorize(TERM.yellow, ch);
      return colorize(TERM.red, ch);
    })
    .join('');
  return `${dim('Now')} ${bar} ${dim('+60m')}`;
}

function noRainMessage(nearestRain, motionReliable) {
  if (nearestRain) {
    const suffix = motionReliable ? ', heading away' : '';
    return `${colorize(TERM.green, 'Dry')} ${dim(`(nearest rain ${nearestRain.km} km ${nearestRain.dir}${suffix})`)}`;
  }
  return colorize(TERM.green, 'No rain detected nearby.');
}

function printNowcast(result) {
  printLogo();
  console.log(bold('Nowcast'));
  console.log(fmtKv('📡', 'Radar', `${result.radarId} — ${result.radarName}`, TERM.blue));
  console.log(fmtKv('🕒', 'Updated', formatDataAge(result.dataAgeMin, result.staleFallback)));
  console.log(fmtKv('🧭', 'Mode', `${result.mode} (${result.frames} frames)`, TERM.magenta));

  for (const entry of result.locations) {
    console.log(hr());
    console.log(bold(`📍 ${entry.name}`));
    if (entry.error) {
      console.log(fmtKv('⚠️', 'Error', entry.error, TERM.yellow));
      continue;
    }
    const rainLabel = entry.rainNow ? fmtStatus('raining', true) : fmtStatus('dry', false);
    console.log(fmtKv('🌧️', 'Status', rainLabel));
    if (!entry.rainNow && entry.etaMin === null) {
      console.log(fmtKv('✅', 'Forecast', noRainMessage(entry.nearestRain, entry.motionReliable)));
      if (entry.motionReliable && entry.motionKmh > 0 && entry.motionDir) {
        console.log(fmtKv('💨', 'Movement', `${entry.motionKmh} km/h → ${entry.motionDir}`, TERM.cyan));
      }
    } else {
      if (entry.rainNow) {
        if (entry.clearEtaMin !== null && entry.clearEtaMin !== undefined) {
          console.log(fmtKv('🌤️', 'Clears in', `~${entry.clearEtaMin} min`, TERM.cyan));
        } else {
          console.log(fmtKv('⏱️', 'ETA', formatEta(entry.etaMin, entry.etaWindowMin)));
        }
      } else {
        console.log(fmtKv('⏱️', 'ETA', formatEta(entry.etaMin, entry.etaWindowMin)));
      }
      console.log(fmtKv('🎚️', 'Intensity', formatIntensity(entry.intensity, entry.intensityTrend)));
      if (entry.motionKmh > 0 && entry.motionDir) {
        console.log(fmtKv('💨', 'Movement', `${entry.motionKmh} km/h → ${entry.motionDir}`, TERM.cyan));
      }
      const spark = formatSparkline(entry.timeline60m);
      if (spark) {
        console.log(fmtKv('📊', 'Next 60m', spark));
      }
      console.log(fmtKv('✅', 'Confidence', formatConfidence(entry.confidence)));
    }
  }
}

function notifyStatePath() {
  return path.join(cacheDir(), '.notify-state.json');
}

function evaluateRainAlert(nowcastResult, opts = {}) {
  const thresholdMin = opts.thresholdMin ?? DEFAULT_NOTIFY_THRESHOLD_MIN;
  const cooldownMs = (opts.cooldownMin ?? DEFAULT_NOTIFY_COOLDOWN_MIN) * 60 * 1000;
  const entry = nowcastResult.locations && nowcastResult.locations[0];
  if (!entry || entry.error) {
    return { shouldNotify: false, notifyTitle: null, notifyBody: null };
  }

  const isAlerting = Boolean(
    entry.rainNow || (entry.etaMin !== null && entry.etaMin <= thresholdMin && entry.confidence >= 0.35)
  );

  let prev = { wasAlerting: false, lastNotifiedAt: 0 };
  const stateFile = notifyStatePath();
  if (fs.existsSync(stateFile)) {
    try {
      prev = { ...prev, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
    } catch {
      // ignore corrupted state
    }
  }

  const now = Date.now();
  const cooldownElapsed = now - (prev.lastNotifiedAt || 0) >= cooldownMs;
  const shouldNotify = isAlerting && (!prev.wasAlerting || cooldownElapsed);

  let notifyTitle = null;
  let notifyBody = null;
  if (isAlerting) {
    const label = entry.intensity && entry.intensity.likelyLabel && entry.intensity.likelyLabel !== 'none'
      ? entry.intensity.likelyLabel
      : 'Rain';
    const capLabel = label.charAt(0).toUpperCase() + label.slice(1);
    const move = entry.motionKmh > 0 && entry.motionDir ? ` (${entry.motionKmh} km/h → ${entry.motionDir})` : '';
    if (entry.rainNow) {
      notifyTitle = `${capLabel} rain at ${entry.name}`;
      notifyBody = entry.clearEtaMin
        ? `Raining now, clears in ~${entry.clearEtaMin} min${move}`
        : `Rain detected overhead${move}`;
    } else {
      const mins = Math.max(1, Math.round(entry.etaMin));
      notifyTitle = `Rain in ~${mins} min`;
      notifyBody = `${capLabel} rain approaching ${entry.name}${move}`;
    }
  }

  if (opts.persistState !== false) {
    try {
      writeFileAtomic(stateFile, JSON.stringify({
        wasAlerting: isAlerting,
        lastNotifiedAt: shouldNotify ? now : (prev.lastNotifiedAt || 0),
        updatedAt: now,
      }));
    } catch {
      // non-fatal
    }
  }

  return { shouldNotify, notifyTitle, notifyBody };
}

function sendDesktopNotification(title, body) {
  const bin = findExecutable('notify-send');
  if (!bin || !title) return false;
  try {
    execFileSync(bin, ['-a', 'BOM Nowcast', '-i', 'weather-showers', title, body || '']);
    return true;
  } catch {
    return false;
  }
}

function shortIntensityTag(label) {
  if (label === 'very heavy') return 'severe';
  if (label === 'heavy') return 'heavy';
  if (label === 'moderate') return 'mod';
  if (label === 'light') return 'light';
  return '';
}

function trendArrow(trend) {
  if (trend === 'building') return '↑';
  if (trend === 'easing') return '↓';
  return '';
}

function buildNoctaliaPayload(nowcastResult, alertInfo = {}) {
  const entry = nowcastResult.locations && nowcastResult.locations[0];
  const ageText = nowcastResult.dataAgeMin !== null && nowcastResult.dataAgeMin !== undefined
    ? (nowcastResult.dataAgeMin <= 1 ? 'just now' : `${nowcastResult.dataAgeMin}m ago`)
    : 'unknown';

  if (!entry || entry.error) {
    return {
      glyph: 'cloud-off',
      text: '',
      color: 'surface_variant',
      tooltip: `${nowcastResult.radarId} • ${entry ? entry.error : 'no location'}\nClick to open radar`,
      rainNow: false,
      etaMin: null,
      ...alertInfo,
    };
  }

  const intensityLabel = entry.intensity ? entry.intensity.likelyLabel : 'none';
  const peakLabel = entry.intensity ? entry.intensity.peakLabel : 'none';
  const isHeavy = peakLabel === 'heavy' || peakLabel === 'very heavy';
  const arrow = trendArrow(entry.intensityTrend);

  let glyph = 'sun';
  let text = '';
  let title = '';
  let subtitle = '';
  let color = 'tertiary';

  if (entry.rainNow) {
    glyph = isHeavy ? 'cloud-storm' : 'cloud-rain';
    color = isHeavy ? 'error' : 'primary';
    const heavyTag = isHeavy ? ` ${shortIntensityTag(peakLabel)}${arrow}` : arrow;
    text = entry.clearEtaMin
      ? `Now${heavyTag} · ${entry.clearEtaMin}m`
      : `Now${heavyTag}`;
    title = entry.clearEtaMin ? `Now · ${entry.clearEtaMin}m` : 'Now';
    subtitle = `${shortIntensityTag(isHeavy ? peakLabel : intensityLabel)}${arrow}`;
  } else if (entry.etaMin !== null) {
    const mins = Math.max(1, Math.round(entry.etaMin));
    glyph = isHeavy ? 'cloud-storm' : 'cloud-rain';
    title = `${mins}m`;
    subtitle = `${shortIntensityTag(isHeavy ? peakLabel : intensityLabel)}${arrow}`;
    if (mins <= 45 || (isHeavy && mins <= 60)) {
      color = mins <= 30 ? (isHeavy ? 'error' : 'primary') : 'secondary';
      text = isHeavy ? `${mins}m ${shortIntensityTag(peakLabel)}${arrow}` : `${mins}m${arrow}`;
    } else {
      color = 'secondary';
      text = '';
    }
  } else if (entry.nearestRain && entry.nearestRain.km <= 40) {
    glyph = 'cloud';
    text = '';
    color = 'secondary';
  }

  const lines = [`${nowcastResult.radarName} • ${ageText}`];
  if (entry.rainNow) {
    const clearTxt = entry.clearEtaMin ? ` • clears ~${entry.clearEtaMin}m` : '';
    const trendTxt = entry.intensityTrend && entry.intensityTrend !== 'steady' ? `, ${entry.intensityTrend}` : '';
    lines.push(`${entry.name}: Raining (${intensityLabel}${trendTxt})${clearTxt}`);
  } else if (entry.etaMin !== null) {
    const mins = Math.round(entry.etaMin);
    const trendTxt = entry.intensityTrend && entry.intensityTrend !== 'steady' ? `, ${entry.intensityTrend}` : '';
    lines.push(`${entry.name}: Rain in ~${mins} ±${entry.etaWindowMin}m (${intensityLabel}${trendTxt})`);
  } else if (entry.nearestRain) {
    lines.push(`${entry.name}: Dry (nearest ${entry.nearestRain.km} km ${entry.nearestRain.dir})`);
  } else {
    lines.push(`${entry.name}: Dry (no rain on radar)`);
  }

  if (entry.sparkline && entry.sparkline.replace(/·/g, '').length > 0) {
    lines.push(`Next 60m: ${entry.sparkline}`);
  }
  if (entry.motionReliable && entry.motionKmh > 0 && entry.motionDir) {
    lines.push(`Movement: ${entry.motionKmh} km/h → ${entry.motionDir}`);
  }
  lines.push('Left-click: open radar • Right-click: refresh');

  return {
    glyph,
    text,
    title,
    subtitle,
    color,
    tooltip: lines.join('\n'),
    rainNow: entry.rainNow,
    etaMin: entry.etaMin !== null ? Math.round(entry.etaMin) : null,
    clearEtaMin: entry.clearEtaMin,
    intensity: intensityLabel,
    intensityTrend: entry.intensityTrend,
    timeline60m: entry.timeline60m || [],
    sparkline: entry.sparkline,
    dataAgeMin: nowcastResult.dataAgeMin,
    shouldNotify: Boolean(alertInfo.shouldNotify),
    notifyTitle: alertInfo.notifyTitle || null,
    notifyBody: alertInfo.notifyBody || null,
  };
}

function extractForecastMotion(nowcastResult) {
  const entry = nowcastResult && nowcastResult.locations && nowcastResult.locations[0];
  if (!entry || entry.error || !entry.motionPxPerMin) return null;
  return {
    vx: entry.motionPxPerMin.vx,
    vy: entry.motionPxPerMin.vy,
    motionReliable: Boolean(entry.motionReliable),
    rainPixels: entry.rainPixels || 0,
  };
}

async function runSetup() {
  const readline = require('readline/promises');
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

  let radarId = await ask('Default radar ID', existing.defaultRadar || 'IDR664');
  while (!RADARS[radarId]) {
    console.log('Please enter a supported radar ID from the list above.');
    radarId = await ask('Default radar ID', existing.defaultRadar || 'IDR664');
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

/**
 * Default command (e.g. Super+Shift+R hotkey):
 * Single scrape, parallel downloads, single decode, instant terminal nowcast,
 * cached/fast GIF loop (with local-time badges & +10/+20/+30m forecast frames),
 * then mpv playback with a distinct Wayland app-id so Hyprland places CLI and radar side-by-side.
 */
async function runDefault(opts = {}) {
  let cfg = loadConfig();
  if (!cfg) {
    console.log('No config found. Starting setup...\n');
    cfg = await runSetup();
  }
  if (!cfg.defaultRadar || !cfg.defaultLocation || !getLocation(cfg, cfg.defaultLocation)) {
    console.log('Config incomplete. Starting setup...\n');
    cfg = await runSetup();
  }

  const preferred = opts.radar || cfg.defaultRadar || 'IDR664';
  const frameCount = parseInt(opts.frames || DEFAULT_LOOP_FRAMES, 10);
  const fresh = Boolean(opts.fresh);
  const forecast = opts.forecast !== false;
  const defaultLocName = cfg.defaultLocation;
  const defaultLoc = getLocation(cfg, defaultLocName);
  const allLocations = cfg.locations || {};

  const { radarId, frames, staleFallback } = await pickRadarAndScrape(preferred, defaultLoc, {
    count: frameCount,
    fresh,
  });

  const frameEntries = await ensureFrames(radarId, frameCount, {
    cacheDays: cfg.cacheDays || DEFAULT_CACHE_DAYS,
    frames,
  });

  let decodedImgs = null;
  let forecastMotion = null;
  if (defaultLoc) {
    const now = nowcastFromFrames(radarId, { [defaultLocName]: defaultLoc }, frameEntries, {
      mode: 'local',
      staleFallback,
    });
    decodedImgs = now._decodedImgs;
    forecastMotion = extractForecastMotion(now);
    printNowcast(now);
    console.log('');
  }

  const renderOpts = {
    decodedImgs,
    fresh,
    forecast,
    forecastMotion,
  };
  const outGif = path.join('/tmp', 'bom-nowcast-loop.gif');
  const gifCached = hasCachedLoopGif(radarId, frameEntries, allLocations, renderOpts);
  const staticLayers = gifCached ? null : await prepareStaticLayers(radarId, allLocations);

  const rendered = await renderLoopGifFromFrames(radarId, frameEntries, outGif, allLocations, {
    ...renderOpts,
    staticLayers,
  });

  if (rendered.forecastFrames > 0) {
    console.log(fmtKv('🔮', 'Forecast loop', `+10m / +20m / +30m projected`, TERM.yellow));
  }

  if (opts.noPlayer) {
    console.log(fmtKv('📁', 'Loop', outGif, TERM.cyan));
    return;
  }

  const mpvBin = findExecutable('mpv');
  if (!mpvBin) {
    console.log(fmtKv('🎬', 'Player', 'mpv not found', TERM.yellow));
    console.log(fmtKv('📁', 'Loop', outGif, TERM.cyan));
    return;
  }

  console.log(fmtKv('🎬', 'Player', 'opening mpv (q to close)', TERM.green));
  console.log(fmtKv('📁', 'Loop', outGif, TERM.cyan));
  const mpvArgs = [
    '--wayland-app-id=org.tongy.bom-nowcast-radar',
    `--title=BOM Radar (${radarId})`,
    '--loop=inf',
    '--no-terminal',
    '--quiet',
    outGif,
  ];
  const mpv = spawn(mpvBin, mpvArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => {
    mpv.on('exit', resolve);
    mpv.on('error', reject);
  });
}

function buildProgram() {
  const program = new Command();
  program
    .name('bom-nowcast')
    .description('Fast Australian BOM radar CLI: loop viewer and rain nowcast');

  program
    .option('--radar <id>', 'Preferred radar product ID (for default run)')
    .option('--frames <n>', 'Frames to include (for default run)', String(DEFAULT_LOOP_FRAMES))
    .option('--fresh', 'Bypass short scrape/render cache')
    .option('--no-forecast', 'Disable projected +10/+20/+30m forecast frames in loop')
    .option('--no-player', 'Render loop and print nowcast without launching mpv')
    .action(async (opts) => {
      await runDefault({
        radar: opts.radar,
        frames: opts.frames,
        fresh: opts.fresh,
        forecast: opts.forecast,
        noPlayer: opts.player === false,
      });
    });

  program
    .command('setup')
    .description('Interactive setup (radar + default location + emoji pins)')
    .action(async () => {
      await runSetup();
    });

  program
    .command('radars')
    .description('List known BOM radars')
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
      const lat = parseFloat(opts.lat);
      const lon = parseFloat(opts.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Latitude and longitude must be valid numbers.');
      }
      cfg.locations[opts.name] = {
        lat,
        lon,
        emoji: opts.emoji || cfg.locations[opts.name]?.emoji,
      };
      if (opts.setDefault) cfg.defaultLocation = opts.name;
      saveConfig(cfg);
      console.log(`Saved location ${opts.name} to ${configPath()}`);
    });

  program
    .command('location-remove')
    .description('Remove a named location from config')
    .requiredOption('--name <name>')
    .action((opts) => {
      const cfg = loadConfig();
      if (!cfg || !cfg.locations || !cfg.locations[opts.name]) {
        throw new Error(`Unknown location: ${opts.name}`);
      }
      delete cfg.locations[opts.name];
      if (cfg.defaultLocation === opts.name) {
        const remaining = Object.keys(cfg.locations);
        cfg.defaultLocation = remaining[0] || '';
      }
      saveConfig(cfg);
      console.log(`Removed location ${opts.name} from ${configPath()}`);
    });

  program
    .command('fetch')
    .description('Fetch latest radar frames into cache')
    .option('--radar <id>', 'Radar product id (e.g. IDR664/IDR663/IDR503)', null)
    .option('--frames <n>', 'Number of frames', '10')
    .option('--fresh', 'Bypass short scrape cache')
    .action(async (opts) => {
      const cfg = loadConfig() || defaultConfig();
      const preferred = opts.radar || cfg.defaultRadar || 'IDR664';
      const defaultLoc = getLocation(cfg, cfg.defaultLocation);
      const n = parseInt(opts.frames, 10);
      const { radarId, frames } = await pickRadarAndScrape(preferred, defaultLoc, {
        count: n,
        fresh: opts.fresh,
      });
      const files = await ensureFrames(radarId, n, {
        cacheDays: cfg.cacheDays || DEFAULT_CACHE_DAYS,
        frames,
      });
      console.log(`radar: ${radarId} (${RADARS[radarId].name})`);
      console.log(`saved: ${files.length} frames -> ${path.join(cacheDir(), radarId)}`);
      console.log(`cache_prune_days: ${cfg.cacheDays || DEFAULT_CACHE_DAYS}`);
    });

  program
    .command('prefetch')
    .description('Warm radar frames and cached loop GIF, with optional Noctalia JSON and desktop alerts')
    .option('--radar <id>', 'Preferred radar product ID', null)
    .option('--frames <n>', 'Frames to warm', String(DEFAULT_LOOP_FRAMES))
    .option('--fresh', 'Bypass short scrape cache')
    .option('--noctalia', 'Print Noctalia widget JSON payload')
    .option('--notify', 'Send desktop notification via notify-send when rain approaches')
    .option('--threshold-min <n>', 'Alert when rain ETA is within N minutes', String(DEFAULT_NOTIFY_THRESHOLD_MIN))
    .option('--cooldown-min <n>', 'Minimum minutes between repeated rain alerts', String(DEFAULT_NOTIFY_COOLDOWN_MIN))
    .action(async (opts) => {
      const cfg = loadConfig() || defaultConfig();
      const preferred = opts.radar || cfg.defaultRadar || 'IDR664';
      const defaultLocName = cfg.defaultLocation;
      const defaultLoc = getLocation(cfg, defaultLocName);
      const n = parseInt(opts.frames, 10);

      const { radarId, frames, staleFallback } = await pickRadarAndScrape(preferred, defaultLoc, {
        count: n,
        fresh: Boolean(opts.fresh),
      });
      const frameEntries = await ensureFrames(radarId, n, {
        cacheDays: cfg.cacheDays || DEFAULT_CACHE_DAYS,
        frames,
      });

      let now = null;
      let decodedImgs = null;
      let forecastMotion = null;
      if (defaultLoc) {
        now = nowcastFromFrames(radarId, { [defaultLocName]: defaultLoc }, frameEntries, {
          mode: 'local',
          staleFallback,
        });
        decodedImgs = now._decodedImgs;
        forecastMotion = extractForecastMotion(now);
      }

      const outGif = path.join('/tmp', 'bom-nowcast-loop.gif');
      const renderOpts = { decodedImgs, forecast: true, forecastMotion };
      const gifCached = hasCachedLoopGif(radarId, frameEntries, cfg.locations || {}, renderOpts);
      const staticLayers = gifCached ? null : await prepareStaticLayers(radarId, cfg.locations || {});
      await renderLoopGifFromFrames(radarId, frameEntries, outGif, cfg.locations || {}, {
        ...renderOpts,
        staticLayers,
      });

      const alertInfo = now
        ? evaluateRainAlert(now, {
            thresholdMin: parseInt(opts.thresholdMin, 10),
            cooldownMin: parseInt(opts.cooldownMin, 10),
            persistState: Boolean(opts.notify || opts.noctalia),
          })
        : { shouldNotify: false, notifyTitle: null, notifyBody: null };

      if (opts.notify && alertInfo.shouldNotify) {
        sendDesktopNotification(alertInfo.notifyTitle, alertInfo.notifyBody);
      }

      if (opts.noctalia && now) {
        console.log(JSON.stringify(buildNoctaliaPayload(now, alertInfo)));
      }
    });

  program
    .command('loop')
    .description('Render a geographic-context loop GIF (background + frames + labels + location emojis)')
    .option('--radar <id>', 'Preferred radar (auto fallback)', null)
    .option('--frames <n>', 'Frames to include', String(DEFAULT_LOOP_FRAMES))
    .option('--out <path>', 'Output gif path', '/tmp/bom-nowcast-loop.gif')
    .option('--delay <ms>', 'Delay per frame in ms', '550')
    .option('--hold <ms>', 'Hold duration on latest frame in ms', '1400')
    .option('--no-forecast', 'Disable projected +10/+20/+30m forecast frames')
    .option('--fresh', 'Bypass scrape and render caches')
    .action(async (opts) => {
      const cfg = loadConfig() || defaultConfig();
      const preferred = opts.radar || cfg.defaultRadar || 'IDR664';
      const defaultLocName = cfg.defaultLocation;
      const defaultLoc = getLocation(cfg, defaultLocName);
      const n = parseInt(opts.frames, 10);
      const { radarId, frames } = await pickRadarAndScrape(preferred, defaultLoc, {
        count: n,
        fresh: opts.fresh,
      });
      const frameEntries = await ensureFrames(radarId, n, {
        cacheDays: cfg.cacheDays || DEFAULT_CACHE_DAYS,
        frames,
      });

      let decodedImgs = null;
      let forecastMotion = null;
      if (opts.forecast !== false && defaultLoc) {
        const now = nowcastFromFrames(radarId, { [defaultLocName]: defaultLoc }, frameEntries, { mode: 'local' });
        decodedImgs = now._decodedImgs;
        forecastMotion = extractForecastMotion(now);
      }

      const delayMs = parseInt(opts.delay, 10);
      const holdMs = parseInt(opts.hold, 10);
      const renderOpts = {
        decodedImgs,
        delayMs,
        holdMs,
        fresh: opts.fresh,
        forecast: opts.forecast !== false,
        forecastMotion,
      };
      const gifCached = hasCachedLoopGif(radarId, frameEntries, cfg.locations || {}, renderOpts);
      const staticLayers = gifCached ? null : await prepareStaticLayers(radarId, cfg.locations || {});
      await renderLoopGifFromFrames(radarId, frameEntries, opts.out, cfg.locations || {}, {
        ...renderOpts,
        staticLayers,
      });

      console.log(`radar: ${radarId} (${RADARS[radarId].name})`);
      console.log(`loop: ${opts.out}`);
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
    .option('--json', 'Output machine-readable JSON')
    .option('--noctalia', 'Output compact JSON payload for Noctalia bar widget')
    .option('--fresh', 'Bypass short scrape cache')
    .action(async (opts) => {
      const cfg = loadConfig() || defaultConfig();
      const preferred = opts.radar || cfg.defaultRadar || 'IDR664';
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
        if (!loc) throw new Error(`Unknown location: ${locName}. Run: bom-nowcast locations`);
        locations = { [locName]: loc };
      }

      const firstLoc = Object.values(locations)[0] || null;
      const { radarId, frames, staleFallback } = await pickRadarAndScrape(preferred, firstLoc, {
        count: Math.max(n, 2),
        fresh: opts.fresh,
      });
      const frameEntries = await ensureFrames(radarId, Math.max(n, 2), {
        cacheDays: cfg.cacheDays || DEFAULT_CACHE_DAYS,
        frames,
      });
      const r = nowcastFromFrames(radarId, locations, frameEntries.slice(-n), {
        mode,
        staleFallback,
      });

      if (opts.noctalia) {
        const alertInfo = evaluateRainAlert(r, { persistState: false });
        console.log(JSON.stringify(buildNoctaliaPayload(r, alertInfo)));
        return;
      }

      if (opts.json) {
        const { _decodedImgs, ...clean } = r;
        console.log(JSON.stringify(clean, null, 2));
        return;
      }

      printNowcast(r);
    });

  return program;
}

async function main(argv = process.argv) {
  const program = buildProgram();
  await program.parseAsync(argv);
}

module.exports = {
  main,
  buildProgram,
  runDefault,
  buildNoctaliaPayload,
  evaluateRainAlert,
};
