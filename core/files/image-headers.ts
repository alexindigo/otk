// SPDX-License-Identifier: LGPL-3.0-only
import type { InlineImageType } from "@otk/protocol";

function has(bytes: Uint8Array, text: string, offset = 0): boolean {
  return [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
}

export function rasterType(bytes: Uint8Array): InlineImageType | undefined {
  if (has(bytes, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (has(bytes, "\xff\xd8\xff")) return "image/jpeg";
  if (has(bytes, "GIF87a") || has(bytes, "GIF89a")) return "image/gif";
  if (has(bytes, "RIFF") && has(bytes, "WEBP", 8)) return "image/webp";
}

type Dimensions = [width: number, height: number];

function exifOrientation(segment: Uint8Array): number {
  if (!has(segment, "Exif\0\0") || segment.length < 14) return 1;
  const bytes = segment.subarray(6);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const little = has(bytes, "II");
  if ((!little && !has(bytes, "MM")) || view.getUint16(2, little) !== 42) {
    return 1;
  }
  const ifd = view.getUint32(4, little);
  if (ifd > bytes.length - 2) return 1;
  const count = view.getUint16(ifd, little);
  for (
    let i = 0, pos = ifd + 2;
    i < count && pos + 12 <= bytes.length;
    i++, pos += 12
  ) {
    if (
      view.getUint16(pos, little) === 0x112 &&
      view.getUint16(pos + 2, little) === 3 &&
      view.getUint32(pos + 4, little) === 1
    ) {
      return view.getUint16(pos + 8, little);
    }
  }
  return 1;
}

function jpeg(bytes: Uint8Array, view: DataView): Dimensions | undefined {
  let orientation = 1;
  let size: Dimensions | undefined;
  for (let pos = 2; pos < bytes.length;) {
    if (bytes[pos++] !== 0xff) break;
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    if (marker === 0xda || marker === 0xd9 || !marker) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (pos + 2 > bytes.length) break;
    const length = view.getUint16(pos);
    if (length < 2 || pos + length > bytes.length) break;
    if (marker === 0xe1) {
      orientation = exifOrientation(bytes.subarray(pos + 2, pos + length));
    }
    if (
      !size && length >= 8 && marker >= 0xc0 && marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    ) {
      size = [view.getUint16(pos + 5), view.getUint16(pos + 3)];
    }
    pos += length;
  }
  if (size) {
    return orientation >= 5 && orientation <= 8 ? [size[1], size[0]] : size;
  }
}

export function rasterSize(
  bytes: Uint8Array,
  mime: InlineImageType,
): Dimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  switch (mime) {
    case "image/png":
      if (
        bytes.length >= 33 && view.getUint32(8) === 13 && has(bytes, "IHDR", 12)
      ) return [view.getUint32(16), view.getUint32(20)];
      break;
    case "image/gif":
      if (bytes.length >= 13) {
        return [view.getUint16(6, true), view.getUint16(8, true)];
      }
      break;
    case "image/jpeg":
      return jpeg(bytes, view);
    case "image/webp": {
      const uint24 = (offset: number) =>
        bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
      if (bytes.length >= 30 && has(bytes, "VP8X", 12)) {
        return [uint24(24) + 1, uint24(27) + 1];
      }
      if (bytes.length >= 25 && has(bytes, "VP8L", 12) && bytes[20] === 0x2f) {
        const packed = view.getUint32(21, true);
        return [(packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1];
      }
      if (
        bytes.length >= 30 && has(bytes, "VP8 ", 12) && !(bytes[20] & 1) &&
        has(bytes, "\x9d\x01\x2a", 23)
      ) {
        return [
          view.getUint16(26, true) & 0x3fff,
          view.getUint16(28, true) & 0x3fff,
        ];
      }
    }
  }
}

const SVG_ROOT = /^<svg(?=[\s/>])((?:[^"'<>]|"[^"]*"|'[^']*')*)>/;
const SVG_ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const px = (value: string | undefined) =>
  value && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value)
    ? Number(value.replace(/px$/, ""))
    : 0;

function svgStart(text: string): string | undefined {
  text = text.trimStart();
  if (/^<\?xml\s/.test(text)) {
    const end = text.indexOf("?>", 6);
    if (end === -1) return;
    text = text.slice(end + 2).trimStart();
  }
  while (text.startsWith("<!--")) {
    const end = text.indexOf("-->", 4);
    if (end === -1) return;
    text = text.slice(end + 3).trimStart();
  }
  return text;
}

export function mightBeSvg(text: string): boolean {
  const start = svgStart(text);
  return start === undefined || "<svg".startsWith(start) ||
    /^<svg[\s/>]/.test(start);
}

export function svgSize(text: string): Dimensions | undefined {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return;
  const root = SVG_ROOT.exec(svgStart(text) ?? "");
  if (!root) return;
  const attrs = Object.fromEntries(
    [...root[1].matchAll(SVG_ATTRIBUTE)].map((
      [, key, a, b],
    ) => [key, (a ?? b).trim()]),
  );
  const width = px(attrs.width);
  const height = px(attrs.height);
  if (width && height) return [width, height];
  const box = attrs.viewBox?.split(/[\s,]+/).map(Number);
  return box?.length === 4 && box.every(Number.isFinite) && box[2] > 0 &&
      box[3] > 0
    ? [box[2], box[3]]
    : [300, 150];
}
