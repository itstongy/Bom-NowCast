'use strict';

const fs = require('fs');
const zlib = require('zlib');

let _PNG = null;
function fallbackReadPng(buf) {
  if (!_PNG) ({ PNG: _PNG } = require('pngjs'));
  return _PNG.sync.read(buf);
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// IEEE 802.3 CRC32 table for fast PNG chunk writing.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterScanlines(raw, height, stride, bpp) {
  const out = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    const srcOff = y * (stride + 1);
    const filter = raw[srcOff];
    const rowOff = y * stride;
    const prevOff = (y - 1) * stride;

    if (filter === 0) {
      raw.copy(out, rowOff, srcOff + 1, srcOff + 1 + stride);
    } else if (filter === 1) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? out[rowOff + i - bpp] : 0;
        out[rowOff + i] = (raw[srcOff + 1 + i] + left) & 0xff;
      }
    } else if (filter === 2) {
      if (y === 0) {
        raw.copy(out, rowOff, srcOff + 1, srcOff + 1 + stride);
      } else {
        for (let i = 0; i < stride; i++) {
          out[rowOff + i] = (raw[srcOff + 1 + i] + out[prevOff + i]) & 0xff;
        }
      }
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? out[rowOff + i - bpp] : 0;
        const up = y > 0 ? out[prevOff + i] : 0;
        out[rowOff + i] = (raw[srcOff + 1 + i] + ((left + up) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? out[rowOff + i - bpp] : 0;
        const up = y > 0 ? out[prevOff + i] : 0;
        const upLeft = (y > 0 && i >= bpp) ? out[prevOff + i - bpp] : 0;
        out[rowOff + i] = (raw[srcOff + 1 + i] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Fast native-zlib PNG decoder for common non-interlaced formats:
 * - Indexed palette (colorType 3, bitDepth 1/2/4/8) — BOM radar & overlays
 * - 8-bit RGB (colorType 2) and 8-bit RGBA (colorType 6) — Twemoji & composites
 * Automatically falls back to pngjs for any other PNG variant.
 */
function readPng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    return fallbackReadPng(buf);
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filterMethod = 0;
  let interlace = 0;
  let plte = null;
  let trns = null;
  const idats = [];

  let off = 8;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;

    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
      compression = buf[dataStart + 10];
      filterMethod = buf[dataStart + 11];
      interlace = buf[dataStart + 12];
    } else if (type === 'PLTE') {
      plte = buf.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = buf.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idats.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4;
  }

  const supportedIndexed = colorType === 3 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4 || bitDepth === 8) && plte;
  const supportedRgba = colorType === 6 && bitDepth === 8;
  const supportedRgb = colorType === 2 && bitDepth === 8 && !trns;

  if (
    width <= 0 || height <= 0 ||
    compression !== 0 || filterMethod !== 0 || interlace !== 0 ||
    idats.length === 0 ||
    (!supportedIndexed && !supportedRgba && !supportedRgb)
  ) {
    return fallbackReadPng(buf);
  }

  const compressed = idats.length === 1 ? idats[0] : Buffer.concat(idats);
  let raw;
  try {
    raw = zlib.inflateSync(compressed);
  } catch {
    return fallbackReadPng(buf);
  }

  if (supportedRgba) {
    const stride = width * 4;
    if (raw.length < height * (stride + 1)) return fallbackReadPng(buf);
    const data = unfilterScanlines(raw, height, stride, 4);
    if (!data) return fallbackReadPng(buf);
    return { width, height, data };
  }

  if (supportedRgb) {
    const stride = width * 3;
    if (raw.length < height * (stride + 1)) return fallbackReadPng(buf);
    const rgb = unfilterScanlines(raw, height, stride, 3);
    if (!rgb) return fallbackReadPng(buf);
    const data = Buffer.allocUnsafe(width * height * 4);
    for (let s = 0, d = 0; s < rgb.length; s += 3, d += 4) {
      data[d] = rgb[s];
      data[d + 1] = rgb[s + 1];
      data[d + 2] = rgb[s + 2];
      data[d + 3] = 255;
    }
    return { width, height, data };
  }

  // Indexed palette (colorType === 3)
  const stride = Math.ceil((width * bitDepth) / 8);
  if (raw.length < height * (stride + 1)) return fallbackReadPng(buf);
  const unpacked = unfilterScanlines(raw, height, stride, 1);
  if (!unpacked) return fallbackReadPng(buf);

  // Prebuild 256-entry RGBA palette lookup.
  const pal = new Uint8Array(256 * 4);
  const palCount = Math.min(256, Math.floor(plte.length / 3));
  for (let i = 0; i < palCount; i++) {
    pal[i * 4] = plte[i * 3];
    pal[i * 4 + 1] = plte[i * 3 + 1];
    pal[i * 4 + 2] = plte[i * 3 + 2];
    pal[i * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
  }

  const data = Buffer.allocUnsafe(width * height * 4);

  if (bitDepth === 4) {
    for (let y = 0; y < height; y++) {
      const rowIn = y * stride;
      let d = y * width * 4;
      let x = 0;
      for (let b = 0; b < stride && x < width; b++) {
        const byte = unpacked[rowIn + b];
        const p0 = ((byte >>> 4) & 0x0f) * 4;
        data[d++] = pal[p0];
        data[d++] = pal[p0 + 1];
        data[d++] = pal[p0 + 2];
        data[d++] = pal[p0 + 3];
        x++;
        if (x < width) {
          const p1 = (byte & 0x0f) * 4;
          data[d++] = pal[p1];
          data[d++] = pal[p1 + 1];
          data[d++] = pal[p1 + 2];
          data[d++] = pal[p1 + 3];
          x++;
        }
      }
    }
  } else if (bitDepth === 2) {
    for (let y = 0; y < height; y++) {
      const rowIn = y * stride;
      let d = y * width * 4;
      let x = 0;
      for (let b = 0; b < stride && x < width; b++) {
        const byte = unpacked[rowIn + b];
        for (let shift = 6; shift >= 0 && x < width; shift -= 2) {
          const p = ((byte >>> shift) & 0x03) * 4;
          data[d++] = pal[p];
          data[d++] = pal[p + 1];
          data[d++] = pal[p + 2];
          data[d++] = pal[p + 3];
          x++;
        }
      }
    }
  } else if (bitDepth === 8) {
    for (let y = 0; y < height; y++) {
      const rowIn = y * stride;
      let d = y * width * 4;
      for (let x = 0; x < width; x++) {
        const p = unpacked[rowIn + x] * 4;
        data[d++] = pal[p];
        data[d++] = pal[p + 1];
        data[d++] = pal[p + 2];
        data[d++] = pal[p + 3];
      }
    }
  } else {
    // bitDepth === 1
    for (let y = 0; y < height; y++) {
      const rowIn = y * stride;
      let d = y * width * 4;
      let x = 0;
      for (let b = 0; b < stride && x < width; b++) {
        const byte = unpacked[rowIn + b];
        for (let shift = 7; shift >= 0 && x < width; shift--) {
          const p = ((byte >>> shift) & 0x01) * 4;
          data[d++] = pal[p];
          data[d++] = pal[p + 1];
          data[d++] = pal[p + 2];
          data[d++] = pal[p + 3];
          x++;
        }
      }
    }
  }

  return { width, height, data };
}

function readPngFile(filePath) {
  return readPng(fs.readFileSync(filePath));
}

function makeChunk(type, payload) {
  const len = payload.length;
  const out = Buffer.allocUnsafe(len + 12);
  out.writeUInt32BE(len, 0);
  out.write(type, 4, 4, 'ascii');
  if (len > 0) payload.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + len), 8 + len);
  return out;
}

/**
 * Fast native-zlib 8-bit RGBA PNG writer (filter 0, deflate level 1).
 * Roughly 8-10x faster than pngjs PNG.sync.write for cached/temp frames.
 */
function writePngFast(img, deflateLevel = 1) {
  const { width, height, data } = img;
  const rowBytes = width * 4;
  const raw = Buffer.allocUnsafe(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const outOff = y * (rowBytes + 1);
    raw[outOff] = 0; // filter None
    data.copy(raw, outOff + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const compressed = zlib.deflateSync(raw, { level: deflateLevel });

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIG,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  readPng,
  readPngFile,
  writePngFast,
};
