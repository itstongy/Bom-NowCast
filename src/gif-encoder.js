'use strict';

/**
 * Minimal pure-JS animated GIF89a encoder used as a zero-dependency fallback
 * when neither ffmpeg nor ImageMagick is installed.
 */

function buildPalette(frames) {
  // Count quantized 5-bit-per-channel colors across all frames, keeping up to 256 most frequent.
  const counts = new Map();
  const exactColor = new Map();
  for (const frame of frames) {
    const d = frame.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const c = (counts.get(key) || 0) + 1;
      counts.set(key, c);
      if (c === 1) exactColor.set(key, (r << 16) | (g << 8) | b);
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 256);
  const palette = new Uint8Array(256 * 3);
  const keyToIdx = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const [key] = sorted[i];
    const rgb = exactColor.get(key);
    palette[i * 3] = (rgb >> 16) & 0xff;
    palette[i * 3 + 1] = (rgb >> 8) & 0xff;
    palette[i * 3 + 2] = rgb & 0xff;
    keyToIdx.set(key, i);
  }
  return { palette, palLen: Math.max(1, sorted.length), keyToIdx };
}

function quantizeFrame(frame, palette, palLen, keyToIdx) {
  const d = frame.data;
  const n = frame.width * frame.height;
  const indices = new Uint8Array(n);
  const fallbackCache = new Map();

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let idx = keyToIdx.get(key);
    if (idx === undefined) {
      idx = fallbackCache.get(key);
      if (idx === undefined) {
        let bestI = 0;
        let bestD = Infinity;
        for (let k = 0; k < palLen; k++) {
          const dr = r - palette[k * 3];
          const dg = g - palette[k * 3 + 1];
          const db = b - palette[k * 3 + 2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bestD) {
            bestD = dist;
            bestI = k;
          }
        }
        idx = bestI;
        fallbackCache.set(key, idx);
      }
    }
    indices[p] = idx;
  }
  return indices;
}

function lzwEncode(indices, minCodeSize = 8) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const bytes = [];
  let bitBuf = 0;
  let bitCount = 0;

  const emit = (code, size) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map();

  emit(clearCode, codeSize);

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
    } else {
      emit(prefix, codeSize);
      if (nextCode < 4096) {
        table.set(key, nextCode++);
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize++;
        }
      } else {
        emit(clearCode, codeSize);
        table = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
  }
  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (bitCount > 0) bytes.push(bitBuf & 0xff);

  // Split into GIF sub-blocks (max 255 bytes each).
  const chunks = [Buffer.from([minCodeSize])];
  for (let off = 0; off < bytes.length; off += 255) {
    const slice = bytes.slice(off, off + 255);
    chunks.push(Buffer.from([slice.length]), Buffer.from(slice));
  }
  chunks.push(Buffer.from([0x00]));
  return Buffer.concat(chunks);
}

/**
 * Encode an array of RGBA frames ({ width, height, data }) into a looping GIF89a Buffer.
 * @param {Array<{width:number,height:number,data:Buffer}>} frames
 * @param {number[]} delaysCs Per-frame delay in centiseconds (1/100s)
 */
function encodeGif(frames, delaysCs) {
  if (!frames.length) throw new Error('no frames to encode');
  const width = frames[0].width;
  const height = frames[0].height;
  const { palette, palLen, keyToIdx } = buildPalette(frames);

  const parts = [];

  // Header + Logical Screen Descriptor (Global Color Table, 256 colors: 0xF7)
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'ascii');
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf7; // GCT flag=1, color res=7, sort=0, size=7 (256 entries)
  header[11] = 0;
  header[12] = 0;
  parts.push(header);
  parts.push(Buffer.from(palette));

  // NETSCAPE2.0 infinite loop extension
  parts.push(Buffer.from([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01, 0x00, 0x00, 0x00,
  ]));

  for (let f = 0; f < frames.length; f++) {
    const delay = delaysCs && delaysCs[f] !== undefined ? delaysCs[f] : 55;
    // Graphic Control Extension
    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = 0x04; // disposal=1 (do not dispose), no transparency
    gce.writeUInt16LE(delay, 4);
    gce[6] = 0;
    gce[7] = 0;
    parts.push(gce);

    // Image Descriptor
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    desc[9] = 0x00;
    parts.push(desc);

    const indices = quantizeFrame(frames[f], palette, palLen, keyToIdx);
    parts.push(lzwEncode(indices, 8));
  }

  // Trailer
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/**
 * Patch Graphic Control Extension frame delays in an existing GIF buffer.
 * Useful after ffmpeg/magick to guarantee exact per-frame and final-frame hold timing.
 */
function patchGifDelays(gifBuf, delaysCs) {
  const buf = Buffer.from(gifBuf);
  let frameIdx = 0;
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04 && buf[i + 7] === 0x00) {
      const delay = delaysCs[Math.min(frameIdx, delaysCs.length - 1)];
      buf.writeUInt16LE(delay, i + 4);
      frameIdx++;
      i += 7;
    }
  }
  return buf;
}

module.exports = {
  encodeGif,
  patchGifDelays,
};
