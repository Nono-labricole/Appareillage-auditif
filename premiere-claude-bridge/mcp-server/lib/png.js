// Décodage/encodage PNG minimal (sans dépendance) + redimensionnement et petite police pour la planche contact.
"use strict";
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Décode un PNG (8 ou 16 bits, gris/RVB/palette, avec ou sans alpha, non entrelacé) -> { width, height, data: RVB 8 bits }. */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Fichier PNG invalide");
  let pos = 8, width, height, depth, colorType, interlace, palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      depth = chunk[8]; colorType = chunk[9]; interlace = chunk[12];
    } else if (type === "PLTE") palette = chunk;
    else if (type === "IDAT") idat.push(chunk);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("PNG entrelacé non pris en charge");
  if (depth !== 8 && depth !== 16) throw new Error(`Profondeur PNG ${depth} bits non prise en charge`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Type de couleur PNG ${colorType} inconnu`);
  const bpp = channels * (depth / 8), stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 3);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
    const step = depth / 8; // en 16 bits on garde l'octet de poids fort
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3, s = x * bpp;
      if (colorType === 3) {
        const p = cur[s] * 3;
        out[o] = palette[p]; out[o + 1] = palette[p + 1]; out[o + 2] = palette[p + 2];
      } else if (channels <= 2) {
        out[o] = out[o + 1] = out[o + 2] = cur[s];
      } else {
        out[o] = cur[s]; out[o + 1] = cur[s + step]; out[o + 2] = cur[s + 2 * step];
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode une image RVB 8 bits en PNG (filtre Paeth). */
function encodePNG({ width, height, data }) {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 4;
    for (let i = 0; i < stride; i++) {
      const p = y * stride + i;
      const a = i >= 3 ? data[p - 3] : 0, b = y ? data[p - stride] : 0, c = i >= 3 && y ? data[p - stride - 3] : 0;
      raw[y * (stride + 1) + 1 + i] = (data[p] - paeth(a, b, c)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Réduction par moyenne de zone. */
function resize(img, newWidth) {
  const w = Math.max(1, Math.round(newWidth)), h = Math.max(1, Math.round(img.height * w / img.width));
  const out = new Uint8Array(w * h * 3), sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const p = (yy * img.width + xx) * 3; r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++;
      }
      const o = (y * w + x) * 3; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { width: w, height: h, data: out };
}

// Police 3x5 pour numéroter les vignettes.
const FONT = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
  "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001010010010",
  "8": "111101111101111", "9": "111101111001111", ".": "000000000000010", ":": "000010000010000",
  "s": "000011110011110", "-": "000000111000000", " ": "000000000000000",
};

function fillRect(img, x, y, w, h, rgb) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) {
      const o = (yy * img.width + xx) * 3; img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2];
    }
}

function drawText(img, text, x, y, scale = 2) {
  const w = text.length * 4 * scale + scale, h = 7 * scale;
  fillRect(img, x, y, w, h, [0, 0, 0]);
  for (let i = 0; i < text.length; i++) {
    const g = FONT[text[i]] || FONT[" "];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++)
      if (g[r * 3 + c] === "1") fillRect(img, x + scale + (i * 4 + c) * scale, y + scale + r * scale, scale, scale, [255, 255, 255]);
  }
}

/** Assemble des vignettes en grille, numérotées 1..n avec leur temps. */
function contactSheet(thumbs, labels, columns) {
  const cols = Math.min(columns, thumbs.length), rows = Math.ceil(thumbs.length / cols), gap = 4;
  const tw = thumbs[0].width, th = Math.max(...thumbs.map((t) => t.height));
  const sheet = { width: cols * tw + (cols + 1) * gap, height: rows * th + (rows + 1) * gap, data: null };
  sheet.data = new Uint8Array(sheet.width * sheet.height * 3).fill(40);
  thumbs.forEach((t, i) => {
    const ox = gap + (i % cols) * (tw + gap), oy = gap + Math.floor(i / cols) * (th + gap);
    for (let y = 0; y < t.height; y++) {
      const src = t.data.subarray(y * t.width * 3, (y + 1) * t.width * 3);
      sheet.data.set(src, ((oy + y) * sheet.width + ox) * 3);
    }
    drawText(sheet, labels[i], ox + 3, oy + 3);
  });
  return sheet;
}

module.exports = { decodePNG, encodePNG, resize, contactSheet };
