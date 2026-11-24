'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const { readPng, writePngFast } = require('../src/fast-png');
const { RADARS, latlonToPixel, orderedRadarsForLocation } = require('../src/radars');
const { parseFrameTimestampMs, parseFramesFromHtml, emojiToCodepoints } = require('../src/bom');
const {
  INTENSITY_ORDER_HEX,
  extractPrecip,
  bestShift,
  computeFrameDeltaMin,
  estimateClearEtaMin,
  findNearestRain,
  buildTimeline60m,
  timelineToSparkline,
  nowcastFromFrames,
} = require('../src/nowcast');
const { alphaOver, alphaOverAt, scalePng, advectRadarFrame, formatLocalTimeLabel } = require('../src/render');
const { drawBadge, drawProgressBar } = require('../src/bitmap-font');
const { buildNoctaliaPayload, evaluateRainAlert } = require('../src/cli');
const { encodeGif, patchGifDelays } = require('../src/gif-encoder');

function makeRadarPng(width, height, drawFn) {
  const data = Buffer.alloc(width * height * 4);
  drawFn((x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const off = (y * width + x) * 4;
    data[off] = r;
    data[off + 1] = g;
    data[off + 2] = b;
    data[off + 3] = a;
  });
  return { width, height, data };
}

function makeIndexedPngBuffer(width, height, bitDepth, paletteRgb, alphaArr, pixelIndices) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, payload) => {
    const out = Buffer.alloc(payload.length + 12);
    out.writeUInt32BE(payload.length, 0);
    out.write(type, 4, 4, 'ascii');
    payload.copy(out, 8);
    let c = 0xffffffff;
    for (let i = 4; i < 8 + payload.length; i++) c = crcTable[(c ^ out[i]) & 0xff] ^ (c >>> 8);
    out.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + payload.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 3; // indexed

  const plte = Buffer.from(paletteRgb);
  const trns = alphaArr ? Buffer.from(alphaArr) : null;

  const stride = Math.ceil((width * bitDepth) / 8);
  const raw = Buffer.alloc(height * (stride + 1));
  const perByte = 8 / bitDepth;
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const idx = pixelIndices[y * width + x];
      const bytePos = Math.floor(x / perByte);
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      raw[y * (stride + 1) + 1 + bytePos] |= (idx & ((1 << bitDepth) - 1)) << shift;
    }
  }

  const parts = [sig, chunk('IHDR', ihdr), chunk('PLTE', plte)];
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test('fast-png decodes 1/2/4/8-bit indexed and RGBA PNGs identically to pngjs', () => {
  const palette = [
    0, 0, 0,
    245, 245, 255,
    0, 216, 195,
    255, 0, 0,
    255, 200, 0,
  ];
  const alphas = [0, 255, 255, 255, 180];

  for (const depth of [1, 2, 4, 8]) {
    const maxIdx = Math.min((1 << depth) - 1, 4);
    const w = 19;
    const h = 13;
    const pixels = Array.from({ length: w * h }, (_, i) => i % (maxIdx + 1));
    const buf = makeIndexedPngBuffer(w, h, depth, palette, alphas, pixels);
    const fast = readPng(buf);
    const ref = PNG.sync.read(buf);
    assert.equal(fast.width, ref.width);
    assert.equal(fast.height, ref.height);
    assert.deepEqual(fast.data, ref.data, `mismatch for indexed depth=${depth}`);
  }

  // Round-trip writePngFast -> readPng & PNG.sync.read
  const src = makeRadarPng(32, 24, (set) => {
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 32; x++) {
        set(x, y, (x * 7) & 255, (y * 11) & 255, (x + y) & 255, (x * y) & 255);
      }
    }
  });
  const encoded = writePngFast(src);
  assert.deepEqual(readPng(encoded).data, src.data);
  assert.deepEqual(PNG.sync.read(encoded).data, src.data);
});

test('radars: orderedRadarsForLocation picks nearby covering radars first', () => {
  const brisbane = { lat: -27.8748, lon: 153.2962 };
  const order = orderedRadarsForLocation('IDR664', brisbane);
  assert.equal(order[0], 'IDR664');
  // Next fallbacks should be Brisbane 128km/256km/Marburg, NOT Sydney/Melbourne
  assert.ok(order.slice(1, 4).every((id) => ['IDR663', 'IDR503', 'IDR662', 'IDR502'].includes(id)), `got ${order.join(',')}`);

  const px = latlonToPixel(RADARS.IDR664, RADARS.IDR664.radarLat, RADARS.IDR664.radarLon, 512, 512);
  assert.equal(px.x, 256);
  assert.equal(px.y, 256);
  assert.equal(px.kmPerPx, 0.25);
});

test('bom: parses frame HTML, UTC timestamps, and Twemoji codepoints', () => {
  const html = `
    theImageNames[0] = "/radar/IDR664.T.202611240214.png";
    theImageNames[1] = "/radar/IDR664.T.202611240219.png";
    theImageNames[2] = "/radar/IDR664.T.202611240219.png";
  `;
  const frames = parseFramesFromHtml(html);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].ts, '202611240214');
  assert.equal(frames[1].tsMs - frames[0].tsMs, 5 * 60 * 1000);
  assert.equal(parseFrameTimestampMs('invalid'), null);

  assert.equal(emojiToCodepoints('🏖️', true), '1f3d6');
  assert.equal(emojiToCodepoints('🏠', true), '1f3e0');
});

test('nowcast: extractPrecip ignores BOM 16px header/footer and greyscale overlays', () => {
  const png = makeRadarPng(512, 512, (set) => {
    // Fake colored noise in top/bottom 16px header/footer (must be ignored)
    set(100, 5, 255, 0, 0, 255);
    set(100, 505, 255, 0, 0, 255);
    // Grey range ring in active area (must be ignored)
    set(200, 200, 192, 192, 192, 255);
    // Real rain pixels
    set(250, 250, 245, 245, 255, 255); // band 0 (light)
    set(251, 250, 255, 0, 0, 255); // band 11 (very heavy)
  });

  const { mask, bandMap, rainPixels } = extractPrecip(png, true);
  assert.equal(rainPixels, 2);
  assert.equal(mask[5 * 512 + 100], 0);
  assert.equal(mask[505 * 512 + 100], 0);
  assert.equal(mask[200 * 512 + 200], 0);
  assert.equal(bandMap[250 * 512 + 250], 0);
  assert.equal(bandMap[250 * 512 + 251], 11);
  assert.equal(INTENSITY_ORDER_HEX.length, 15);
});

test('nowcast: bestShift matches exact shift for both small and large rain bands', () => {
  const w = 512;
  const makeBlobMask = (cx, cy, rx, ry) => {
    const m = new Uint8Array(w * w);
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) {
          m[y * w + x] = 1;
        }
      }
    }
    return m;
  };

  // Large rain shield (triggers 4x coarse-to-fine path: > 1200 active pixels)
  const m0 = makeBlobMask(200, 220, 45, 35);
  const m1 = makeBlobMask(211, 213, 45, 35); // true shift: dx = +11, dy = -7
  const res = bestShift(m0, m1, w, { minX: 120, minY: 140, maxX: 300, maxY: 300 }, 20);
  assert.equal(res.dx, 11);
  assert.equal(res.dy, -7);
  assert.ok(res.score > 4500);

  // Small shower cell (exact sparse path: < 1200 pixels)
  const s0 = makeBlobMask(200, 200, 12, 10);
  const s1 = makeBlobMask(192, 206, 12, 10); // true shift: dx = -8, dy = +6
  const sRes = bestShift(s0, s1, w, { minX: 150, minY: 150, maxX: 250, maxY: 250 }, 20);
  assert.equal(sRes.dx, -8);
  assert.equal(sRes.dy, 6);
});

test('nowcast: tracks approaching storm ETA with real 6-minute timestamps and estimates clear time when raining', () => {
  const w = 512;
  // Place target at radar center (256, 256)
  const radar = RADARS.IDR664;
  const target = { lat: radar.radarLat, lon: radar.radarLon };

  // Build 4 frames spaced 6 minutes apart; rain blob moves East (+12 px per 6 min = +2 px/min)
  const centersX = [176, 188, 200, 212];
  const baseTs = Date.UTC(2026, 10, 24, 2, 0);
  const frameEntries = centersX.map((_, i) => ({
    file: `IDR664.T.test${i}.png`,
    ts: `2026112402${String(i * 6).padStart(2, '0')}`,
    tsMs: baseTs + i * 6 * 60 * 1000,
    path: `/unused/${i}`,
  }));

  const decodedImgs = centersX.map((cx) =>
    makeRadarPng(w, w, (set) => {
      for (let y = 236; y <= 276; y++) {
        for (let x = cx - 20; x <= cx + 20; x++) {
          set(x, y, 0, 150, 144, 255); // band 5 (moderate rain)
        }
      }
    })
  );

  assert.equal(computeFrameDeltaMin(frameEntries[0], frameEntries[1]), 6);

  const result = nowcastFromFrames('IDR664', { Home: target }, frameEntries, {
    mode: 'local',
    decodedImgs,
  });
  const loc = result.locations[0];
  assert.equal(loc.rainNow, false);
  // Center is at x=212, target at x=256 (44 px away), speed = 2 px/min -> median ETA ~22 min
  assert.ok(loc.etaMin >= 18 && loc.etaMin <= 26, `expected ETA ~22 min, got ${loc.etaMin}`);
  assert.equal(loc.intensity.likelyLabel, 'moderate');
  assert.equal(loc.motionDir, 'E');
  assert.equal(loc.motionKmh, 30); // 2 px/min * 0.25 km/px * 60 = 30 km/h
  assert.ok(loc.confidence >= 0.7);

  // Now check raining-now clearEtaMin: target inside rain cell [236..276] moving East at 2 px/min
  const rainingMask = new Uint8Array(w * w);
  for (let y = 240; y <= 272; y++) {
    for (let x = 236; x <= 276; x++) rainingMask[y * w + x] = 1;
  }
  const clearMin = estimateClearEtaMin(rainingMask, w, 256, 256, 2, 0);
  // Upstream edge is 20 px west of 256 -> clears in ~11-12 min
  assert.ok(clearMin >= 9 && clearMin <= 14, `expected clear ~11 min, got ${clearMin}`);

  // Check nearestRain direction
  const nr = findNearestRain(rainingMask, w, 256, 300, 0.25);
  assert.equal(nr.dir, 'N');
  assert.equal(nr.km, 7); // 28 px * 0.25 km/px = 7.0 km
});

test('render & gif-encoder: alphaOver, scalePng, encodeGif, and patchGifDelays', () => {
  const dst = makeRadarPng(4, 4, (set) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x, y, 100, 100, 100, 255);
  });
  const src = makeRadarPng(4, 4, (set) => {
    set(0, 0, 200, 50, 20, 255);
    set(1, 0, 200, 0, 0, 128);
  });
  alphaOver(dst, src);
  assert.deepEqual([...dst.data.subarray(0, 4)], [200, 50, 20, 255]);
  assert.ok(dst.data[4] > 140 && dst.data[4] < 160);

  const tiny = scalePng(dst, 2);
  assert.equal(tiny.width, 2);
  assert.equal(tiny.height, 2);

  alphaOverAt(dst, tiny, 2, 2);
  assert.equal(dst.data[(2 * 4 + 2) * 4], 200);

  // Pure-JS GIF encoder + delay patcher
  const gif = encodeGif([dst, src], [50, 140]);
  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3b);
  const patched = patchGifDelays(gif, [60, 180]);
  const delays = [];
  for (let i = 0; i < patched.length - 8; i++) {
    if (patched[i] === 0x21 && patched[i + 1] === 0xf9 && patched[i + 2] === 0x04 && patched[i + 7] === 0x00) {
      delays.push(patched.readUInt16LE(i + 4));
    }
  }
  assert.deepEqual(delays, [60, 180]);
});

test('CLI: config-init, location-add, locations, location-remove, radars', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bom-cli-test-'));
  const env = { ...process.env, HOME: tmpHome };
  const cli = path.join(__dirname, '..', 'bom-nowcast.js');
  try {
    execFileSync('node', [cli, 'config-init'], { env });
    execFileSync('node', [cli, 'location-add', '--name', 'Work', '--lat', '-27.47', '--lon', '153.02', '--emoji', '🏢'], { env });
    const locs = execFileSync('node', [cli, 'locations'], { env, encoding: 'utf8' });
    assert.match(locs, /\* .* Default:/);
    assert.match(locs, /Work: -27\.47, 153\.02/);

    execFileSync('node', [cli, 'location-remove', '--name', 'Work'], { env });
    const after = execFileSync('node', [cli, 'locations'], { env, encoding: 'utf8' });
    assert.doesNotMatch(after, /Work:/);

    const radars = execFileSync('node', [cli, 'radars'], { env, encoding: 'utf8' });
    assert.match(radars, /IDR664/);
    assert.match(radars, /IDR714/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('timeline60m, intensity trend, forecast advection, bitmap badges, and Noctalia payload', () => {
  const w = 512;
  const radar = RADARS.IDR664;
  const target = { lat: radar.radarLat, lon: radar.radarLon };

  // Approaching storm intensifying from band 1 (light) -> band 5 (moderate) -> band 9 (heavy)
  const centersX = [176, 188, 200, 212];
  const colors = [
    [180, 180, 255], // band 1
    [20, 20, 255],   // band 3
    [0, 150, 144],   // band 5
    [255, 100, 0],   // band 10 (heavy)
  ];
  const baseTs = Date.UTC(2026, 10, 24, 2, 0);
  const frameEntries = centersX.map((_, i) => ({
    file: `IDR664.T.trend${i}.png`,
    ts: `2026112402${String(i * 6).padStart(2, '0')}`,
    tsMs: baseTs + i * 6 * 60 * 1000,
    path: `/unused/${i}`,
  }));

  const decodedImgs = centersX.map((cx, idx) => {
    const [r, g, b] = colors[idx];
    return makeRadarPng(w, w, (set) => {
      for (let y = 236; y <= 276; y++) {
        for (let x = cx - 20; x <= cx + 20; x++) {
          set(x, y, r, g, b, 255);
        }
      }
    });
  });

  const result = nowcastFromFrames('IDR664', { Home: target }, frameEntries, {
    mode: 'local',
    decodedImgs,
  });
  const loc = result.locations[0];
  assert.equal(loc.intensityTrend, 'building');
  assert.equal(loc.timeline60m.length, 12);
  assert.equal(loc.sparkline.length, 12);
  // Rain is 44px west at 2px/min -> buckets 3..6 (15..35m) should be active
  assert.ok(loc.timeline60m.slice(2, 7).some((b) => b >= 8), `timeline: ${loc.timeline60m}`);
  assert.equal(timelineToSparkline([-1, 0, 14]), '·▁█');
  assert.equal(buildTimeline60m(new Int8Array(w * w).fill(-1), w, 256, 256, 2, 0, false, true).every((b) => b === -1), true);

  // Advect latest frame by +10 min (+20 px East)
  const adv = advectRadarFrame(decodedImgs[3], 2, 0, 10);
  // Original center was x=212, advected center should be x=232 with forecast alpha 195
  const off = (256 * w + 232) * 4;
  assert.equal(adv.data[off], 255);
  assert.equal(adv.data[off + 1], 100);
  assert.equal(adv.data[off + 3], 195);

  // Badge and progress bar rendering
  drawBadge(adv, 'FCST +10M 1:04 PM', { dotColor: [245, 158, 11] });
  drawProgressBar(adv, 7, 7, 10);
  assert.equal(adv.data[(510 * w + 10) * 4 + 3], 255);
  assert.match(formatLocalTimeLabel(baseTs), /^\d{1,2}:\d{2} (AM|PM)$/);

  // Noctalia payload & alert evaluation (rich bar text when rain approaches or falls)
  const alert = evaluateRainAlert(result, { thresholdMin: 30, persistState: false });
  assert.equal(alert.shouldNotify, true);
  assert.match(alert.notifyTitle, /Rain in ~\d+ min/);
  const payload = buildNoctaliaPayload(result, alert);
  assert.equal(payload.glyph, 'cloud-storm');
  assert.match(payload.text, /^\d+m heavy↑ .*[▁-█]/);
  assert.match(payload.tooltip, /Next 60m:/);
  assert.match(payload.tooltip, /building/);

  // Raining-now bar text includes clear time and sparkline
  const rainingPayload = buildNoctaliaPayload({
    ...result,
    locations: [{ ...loc, rainNow: true, etaMin: 0, clearEtaMin: 28, sparkline: '▆▆▆▃▃▁······' }],
  });
  assert.equal(rainingPayload.text, 'Now heavy↑ (28m left) ▆▆▆▃▃▁······');

  // Dry skies stay quiet (icon-only, empty bar text)
  const dryPayload = buildNoctaliaPayload({
    ...result,
    locations: [{ ...loc, rainNow: false, etaMin: null, nearestRain: { km: 25, dir: 'W' }, sparkline: '············' }],
  });
  assert.equal(dryPayload.glyph, 'cloud');
  assert.equal(dryPayload.text, '');
});
