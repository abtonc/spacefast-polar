// HMAC-SHA256 that prefers WebCrypto and falls back to a pure implementation.
// The fallback exists for the Zero QuickJS runner, which has no crypto.subtle,
// and whose own ctx.crypto.hmacSha256 cannot take the binary keys that
// Standard Webhooks secrets decode to.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_SIZE = 64;

/** SHA-256 of `data`, computed in plain JavaScript. */
export function sha256(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const paddedLength = Math.ceil((data.length + 9) / BLOCK_SIZE) * BLOCK_SIZE;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  // Message length in bits, big-endian, in the last 8 bytes. Split so lengths
  // over 2^32 bits survive the 32-bit bitwise operators.
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let index = 0; index < 4; index++) {
    padded[paddedLength - 8 + index] = (high >>> (24 - index * 8)) & 0xff;
    padded[paddedLength - 4 + index] = (low >>> (24 - index * 8)) & 0xff;
  }

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += BLOCK_SIZE) {
    for (let t = 0; t < 16; t++) {
      const i = offset + t * 4;
      w[t] = (padded[i]! << 24) | (padded[i + 1]! << 16) | (padded[i + 2]! << 8) | padded[i + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }

    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[t]! + w[t]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    hash[0] = hash[0]! + a;
    hash[1] = hash[1]! + b;
    hash[2] = hash[2]! + c;
    hash[3] = hash[3]! + d;
    hash[4] = hash[4]! + e;
    hash[5] = hash[5]! + f;
    hash[6] = hash[6]! + g;
    hash[7] = hash[7]! + h;
  }

  const out = new Uint8Array(32);
  for (let index = 0; index < 8; index++) {
    const word = hash[index]!;
    out[index * 4] = word >>> 24;
    out[index * 4 + 1] = (word >>> 16) & 0xff;
    out[index * 4 + 2] = (word >>> 8) & 0xff;
    out[index * 4 + 3] = word & 0xff;
  }
  return out;
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** HMAC-SHA256 (RFC 2104) in plain JavaScript. */
export function hmacSha256Sync(key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockKey = new Uint8Array(BLOCK_SIZE);
  blockKey.set(key.length > BLOCK_SIZE ? sha256(key) : key);
  const inner = new Uint8Array(BLOCK_SIZE + data.length);
  const outer = new Uint8Array(BLOCK_SIZE + 32);
  for (let index = 0; index < BLOCK_SIZE; index++) {
    inner[index] = blockKey[index]! ^ 0x36;
    outer[index] = blockKey[index]! ^ 0x5c;
  }
  inner.set(data, BLOCK_SIZE);
  outer.set(sha256(inner), BLOCK_SIZE);
  return sha256(outer);
}

type SubtleLike = {
  importKey(format: "raw", key: Uint8Array, algorithm: { name: "HMAC"; hash: "SHA-256" }, extractable: false, usages: ["sign"]): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
};

function subtle(): SubtleLike | null {
  if (typeof crypto === "undefined" || !crypto || !crypto.subtle) return null;
  return crypto.subtle as unknown as SubtleLike;
}

/** HMAC-SHA256 using WebCrypto when the runtime has it, otherwise the pure fallback. */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const webCrypto = subtle();
  if (webCrypto) {
    try {
      const cryptoKey = await webCrypto.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return new Uint8Array(await webCrypto.sign("HMAC", cryptoKey, data));
    } catch {
      // Some runtimes expose a partial subtle (or reject zero-length keys).
      // The pure implementation gives the same answer.
    }
  }
  return hmacSha256Sync(key, data);
}
