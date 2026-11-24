'use strict';

// Minimal 5x7 uppercase/digit bitmap font for crisp frame badges (zero dependencies).
const FONT_5X7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x0e, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x0e],
  ':': [0x00, 0x04, 0x04, 0x00, 0x04, 0x04, 0x00],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  'A': [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'B': [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  'C': [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  'D': [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  'E': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  'F': [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  'G': [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  'H': [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  'I': [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  'J': [0x07, 0x02, 0x02, 0x02, 0x12, 0x12, 0x0c],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  'M': [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'P': [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  'R': [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  'S': [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  'T': [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  'X': [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  'Z': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};

function blendRect(img, x0, y0, rw, rh, r, g, b, a) {
  const { width, height, data } = img;
  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  const xEnd = Math.min(width, x0 + rw);
  const yEnd = Math.min(height, y0 + rh);
  const invA = 255 - a;

  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const off = (y * width + x) << 2;
      if (a === 255) {
        data[off] = r;
        data[off + 1] = g;
        data[off + 2] = b;
        data[off + 3] = 255;
      } else {
        data[off] = ((r * a + data[off] * invA + 127) / 255) | 0;
        data[off + 1] = ((g * a + data[off + 1] * invA + 127) / 255) | 0;
        data[off + 2] = ((b * a + data[off + 2] * invA + 127) / 255) | 0;
        data[off + 3] = 255;
      }
    }
  }
}

function drawText(img, text, x0, y0, scale, color) {
  const upper = String(text || '').toUpperCase();
  const [r, g, b] = color;
  let cx = x0;
  for (let i = 0; i < upper.length; i++) {
    const glyph = FONT_5X7[upper[i]] || FONT_5X7[' '];
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 5; col++) {
        if ((bits & (1 << (4 - col))) !== 0) {
          blendRect(img, cx + col * scale, y0 + row * scale, scale, scale, r, g, b, 255);
        }
      }
    }
    cx += 6 * scale;
  }
}

/**
 * Draw a sleek dark translucent badge with a colored status dot and crisp bitmap text.
 */
function drawBadge(img, text, opts = {}) {
  const scale = opts.scale || 2;
  const x = opts.x ?? 8;
  const y = opts.y ?? 22;
  const padX = 8;
  const padY = 5;
  const dotSize = opts.dotColor ? 6 : 0;
  const dotGap = opts.dotColor ? 6 : 0;

  const upper = String(text || '').toUpperCase();
  const textW = Math.max(0, upper.length * 6 * scale - scale);
  const textH = 7 * scale;
  const boxW = padX * 2 + dotSize + dotGap + textW;
  const boxH = padY * 2 + textH;

  // Dark translucent pill background + 1px subtle border
  const bg = opts.bgColor || [18, 22, 26, 238];
  const border = opts.borderColor || [211, 198, 170, 110];
  blendRect(img, x, y, boxW, boxH, bg[0], bg[1], bg[2], bg[3]);
  blendRect(img, x, y, boxW, 1, border[0], border[1], border[2], border[3]);
  blendRect(img, x, y + boxH - 1, boxW, 1, border[0], border[1], border[2], border[3]);
  blendRect(img, x, y, 1, boxH, border[0], border[1], border[2], border[3]);
  blendRect(img, x + boxW - 1, y, 1, boxH, border[0], border[1], border[2], border[3]);

  if (opts.dotColor) {
    const dy = y + Math.floor((boxH - dotSize) / 2);
    blendRect(img, x + padX, dy, dotSize, dotSize, opts.dotColor[0], opts.dotColor[1], opts.dotColor[2], 255);
  }

  const fg = opts.textColor || [240, 244, 248];
  drawText(img, upper, x + padX + dotSize + dotGap, y + padY, scale, fg);
}

/**
 * Draw a 3px timeline bar along the bottom edge (rows 509..511, below BOM's footer text).
 * Distinguishes historical frames (cyan), NOW anchor (green), and forecast frames (amber).
 */
function drawProgressBar(img, frameIndex, historyCount, totalCount) {
  const { width, height } = img;
  if (totalCount <= 1 || height < 4) return;
  const barH = 3;
  const y0 = height - barH;

  // Subtle dark track
  blendRect(img, 0, y0, width, barH, 20, 24, 28, 210);

  const histEndX = Math.round((historyCount / totalCount) * width);
  const fillX = Math.round(((frameIndex + 1) / totalCount) * width);
  const isNow = frameIndex === historyCount - 1;
  const isForecast = frameIndex >= historyCount;

  if (!isForecast) {
    const color = isNow ? [74, 222, 128] : [56, 189, 248];
    blendRect(img, 0, y0, fillX, barH, color[0], color[1], color[2], 255);
  } else {
    // Completed history portion in muted green + projected forecast portion in warm amber
    blendRect(img, 0, y0, histEndX, barH, 74, 222, 128, 210);
    blendRect(img, histEndX, y0, Math.max(0, fillX - histEndX), barH, 245, 158, 11, 255);
  }

  // Tiny white notch marking the NOW boundary when forecast frames are present
  if (totalCount > historyCount && histEndX > 1 && histEndX < width - 1) {
    blendRect(img, histEndX - 1, y0, 2, barH, 255, 255, 255, 255);
  }
}

module.exports = {
  blendRect,
  drawText,
  drawBadge,
  drawProgressBar,
};
