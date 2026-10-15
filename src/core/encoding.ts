// Byte helpers that do not depend on TextEncoder, atob, or Buffer, so the same
// code runs in Workers, Node, browsers, and the Zero QuickJS runner.

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP: Record<string, number> = {};
for (let index = 0; index < BASE64_ALPHABET.length; index++) {
  BASE64_LOOKUP[BASE64_ALPHABET[index]!] = index;
}
// Accept the URL-safe alphabet too.
BASE64_LOOKUP["-"] = 62;
BASE64_LOOKUP["_"] = 63;

export function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index++;
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // Lone surrogate.
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let out = "";
  for (let index = 0; index < bytes.length; ) {
    const byte = bytes[index]!;
    let code: number;
    let extra: number;
    if (byte < 0x80) {
      code = byte;
      extra = 0;
    } else if (byte >= 0xc0 && byte < 0xe0) {
      code = byte & 0x1f;
      extra = 1;
    } else if (byte >= 0xe0 && byte < 0xf0) {
      code = byte & 0x0f;
      extra = 2;
    } else if (byte >= 0xf0 && byte < 0xf8) {
      code = byte & 0x07;
      extra = 3;
    } else {
      out += "�";
      index++;
      continue;
    }
    let valid = index + extra < bytes.length;
    for (let offset = 1; valid && offset <= extra; offset++) {
      const continuation = bytes[index + offset]!;
      if ((continuation & 0xc0) !== 0x80) valid = false;
      else code = (code << 6) | (continuation & 0x3f);
    }
    if (!valid || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += "�";
      index++;
      continue;
    }
    index += extra + 1;
    out += String.fromCodePoint(code);
  }
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = index + 1 < bytes.length ? bytes[index + 1]! : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2]! : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63]!;
    out += BASE64_ALPHABET[(triple >> 12) & 63]!;
    out += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63]! : "=";
    out += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63]! : "=";
  }
  return out;
}

/** Decodes standard or URL-safe base64. Returns null when the input is not base64. */
export function base64Decode(value: string): Uint8Array | null {
  const clean = value.replace(/=+$/, "");
  if (clean.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < clean.length; index++) {
    const sextet = BASE64_LOOKUP[clean[index]!];
    if (sextet === undefined) return null;
    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/** Compares two byte arrays without short-circuiting on the first difference. */
export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left[index]! ^ right[index]!;
  return diff === 0;
}
