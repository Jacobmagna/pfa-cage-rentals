// Travel parent (guardian) password hashing. Ported VERBATIM (algorithm +
// encoding) from Northstar's src/lib/server/password.ts so the two share one
// vetted primitive. See that file for the full rationale.
//
// Algorithm: Node's built-in `crypto.scrypt` (no new dependency). scrypt is a
// memory-hard, well-vetted KDF. Each hash uses a fresh 16-byte random salt.
//
// Stored encoding (self-describing so cost params travel WITH the hash):
//
//     scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
//
//   N = CPU/memory cost (power of two), r = block size, p = parallelization,
//   keylen = 64 bytes. Verify reads the params back out of the stored string,
//   so old hashes keep verifying even after a cost bump.
//
// Verification is CONSTANT-TIME (crypto.timingSafeEqual). Any malformed stored
// hash → verify returns false (never throws, never matches).
//
// server-only: it hashes secrets.

import "server-only";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt cost parameters for NEW hashes. N=2^16 (65536) with r=8,p=1 is a
// strong interactive-login cost. scrypt's default maxmem (32 MiB) is too small
// for N=2^16 (needs ~128*N*r ≈ 64 MiB), so we raise it.
const SCRYPT_N = 16384 * 4; // 65536
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
// 128 * N * r bytes of working memory, plus headroom.
const MAXMEM = 256 * 1024 * 1024;

const PREFIX = "scrypt";

function scryptAsync(
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keylen,
      { N: opts.N, r: opts.r, p: opts.p, maxmem: MAXMEM },
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey);
      },
    );
  });
}

/**
 * Hash a plaintext password into a self-describing scrypt-encoded string.
 * Each call uses a fresh random salt, so hashing the same password twice
 * yields two DIFFERENT strings. Safe to store verbatim in
 * travelGuardians.passwordHash. Never returns the plaintext.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plain, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

/**
 * Verify a plaintext password against a stored scrypt-encoded hash, in
 * constant time. Returns false (never throws) for ANY malformed/unparseable
 * stored value, an empty/missing input, or a real mismatch. The scrypt params
 * are read back out of the stored string so old hashes keep verifying after a
 * cost bump.
 */
export async function verifyPassword(
  plain: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored || typeof stored !== "string") return false;

  const parts = stored.split("$");
  // scrypt$N$r$p$saltHex$hashHex — exactly six parts.
  if (parts.length !== 6) return false;
  const [prefix, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (prefix !== PREFIX) return false;

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N <= 1 ||
    r < 1 ||
    p < 1
  ) {
    return false;
  }

  // Decode the stored salt + hash. Invalid hex (or empty) → reject.
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scryptAsync(plain, salt, expected.length, {
      N,
      r,
      p,
    });
  } catch {
    // A pathological stored param (e.g. an absurd N exceeding maxmem) makes
    // scrypt throw — treat as a non-match rather than a 500.
    return false;
  }

  // Lengths are equal by construction (we derived `expected.length` bytes),
  // but guard before timingSafeEqual which throws on a length mismatch.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
