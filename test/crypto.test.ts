import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, timingSafeEqual, utf8Decode, utf8Encode } from "../src/core/encoding.ts";
import { hmacSha256, hmacSha256Sync, sha256 } from "../src/core/hmac.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("sha256", () => {
  it("matches node:crypto across block boundaries", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const data = randomBytes(length);
      expect(hex(sha256(data)), `length ${length}`).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });
});

describe("hmacSha256", () => {
  it("matches node:crypto for short, block-sized, and long keys", async () => {
    for (const keyLength of [0, 1, 32, 64, 65, 200]) {
      const key = randomBytes(keyLength);
      const data = randomBytes(777);
      const expected = createHmac("sha256", key).update(data).digest("hex");
      expect(hex(hmacSha256Sync(key, data)), `sync, key ${keyLength}`).toBe(expected);
      expect(hex(await hmacSha256(key, data)), `async, key ${keyLength}`).toBe(expected);
    }
  });
});

describe("encoding", () => {
  it("encodes UTF-8 like TextEncoder, including astral and lone surrogates", () => {
    for (const value of ["", "plain ascii", "çağrı ü", "日本語", "emoji 🎉👩‍💻", "lone \ud800 surrogate", "\udfff"]) {
      expect(Array.from(utf8Encode(value)), value).toEqual(Array.from(new TextEncoder().encode(value)));
    }
  });

  it("decodes UTF-8 round trip", () => {
    const value = "polar ✓ 🎉 spacefast";
    expect(utf8Decode(utf8Encode(value))).toBe(value);
  });

  it("round-trips base64 against Buffer", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 100]) {
      const bytes = randomBytes(length);
      const encoded = base64Encode(bytes);
      expect(encoded).toBe(bytes.toString("base64"));
      expect(Array.from(base64Decode(encoded)!)).toEqual(Array.from(bytes));
    }
  });

  it("accepts URL-safe base64 and rejects junk", () => {
    expect(Array.from(base64Decode("-_8")!)).toEqual([0xfb, 0xff]);
    expect(base64Decode("not base64!")).toBeNull();
    expect(base64Decode("A")).toBeNull();
  });

  it("compares bytes", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
