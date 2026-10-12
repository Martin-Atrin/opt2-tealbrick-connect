/**
 * Nostr primitives for Buzz agent identities (harvest: v1 channels/providers/nostr.ts:29-171).
 * - BIP-340 keys and signatures with @noble/curves (pinned 2.4.0), fresh 32-byte aux randomness, key bytes zeroed.
 * - NIP-01 event id = sha256(JSON [0, pubkey, created_at, kind, tags, content]).
 * - ONE signing function with a kind allowlist: a call path cannot sign arbitrary kinds.
 *   opt2 list: 0 profile (as-itself identity), 9 chat, 7 reaction, 5 deletion, 40003 edit, 41010 DM open,
 *   20002 typing, 22242 NIP-42 AUTH, 27235 NIP-98 HTTP auth, 24242 Blossom auth. v1 group-admin kinds
 *   (9007/9000/9001/9008) are dropped with the v1 Buzz bridge (HARVEST-CHANNELS F2).
 * - NIP-OA owner attestation is NOT used in opt2 (DECISION-LOG C22).
 */
import { randomBytes } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const HEX64 = /^[0-9a-f]{64}$/u;
export const SIGNABLE_KINDS: readonly number[] = Object.freeze([0, 9, 7, 5, 40003, 41010, 20002, 22242, 27235, 24242]);

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}
export interface NostrEvent extends UnsignedEvent {
  id: string;
  pubkey: string;
  sig: string;
}

export class KindNotAllowedError extends Error {
  readonly code = "buzz_kind_not_allowed";
  readonly kind: number;
  constructor(kind: number) {
    super("buzz_kind_not_allowed");
    this.kind = kind;
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

export function generateSecretKey(): string {
  const key = schnorr.utils.randomSecretKey();
  try {
    return hex(key);
  } finally {
    key.fill(0);
  }
}

export function publicKeyOf(secretHex: string): string {
  if (!HEX64.test(secretHex)) throw new Error("nostr_key_invalid");
  const secret = unhex(secretHex);
  try {
    return hex(schnorr.getPublicKey(secret));
  } finally {
    secret.fill(0);
  }
}

export function eventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
  return hex(sha256(new TextEncoder().encode(serialized)));
}

export function signEvent(secretHex: string, input: UnsignedEvent): NostrEvent {
  if (!SIGNABLE_KINDS.includes(input.kind)) throw new KindNotAllowedError(input.kind);
  if (!Number.isInteger(input.created_at) || input.created_at < 0) throw new Error("nostr_created_at_invalid");
  const pubkey = publicKeyOf(secretHex);
  const unsigned = { pubkey, created_at: input.created_at, kind: input.kind, tags: input.tags, content: input.content };
  const id = eventId(unsigned);
  const secret = unhex(secretHex);
  try {
    const sig = hex(schnorr.sign(unhex(id), secret, new Uint8Array(randomBytes(32))));
    return { id, ...unsigned, sig };
  } finally {
    secret.fill(0);
  }
}

/** Shape, recomputed id and BIP-340 signature. For untrusted input. */
export function verifyEvent(value: unknown): value is NostrEvent {
  const e = value as Partial<NostrEvent> | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.id !== "string" || !HEX64.test(e.id) || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return false;
  if (typeof e.sig !== "string" || !/^[0-9a-f]{128}$/u.test(e.sig)) return false;
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65_535) return false;
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at) || typeof e.content !== "string") return false;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"))) return false;
  if (eventId({ pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags, content: e.content }) !== e.id) return false;
  try {
    return schnorr.verify(unhex(e.sig), unhex(e.id), unhex(e.pubkey));
  } catch {
    return false;
  }
}

// NIP-19 bech32 (npub only; Connect never shows or accepts an nsec).
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const;

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if ((top >>> bit) & 1) checksum ^= GENERATOR[bit] as number;
  }
  return checksum;
}

function hrpExpand(hrp: string): number[] {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >>> 5), 0, ...codes.map((c) => c & 31)];
}

export function npubEncode(pubkeyHex: string): string {
  if (!HEX64.test(pubkeyHex)) throw new Error("nostr_pubkey_invalid");
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of Buffer.from(pubkeyHex, "hex")) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const checksum = polymod([...hrpExpand("npub"), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail = Array.from({ length: 6 }, (_, i) => (checksum >>> (5 * (5 - i))) & 31);
  return `npub1${[...words, ...tail].map((w) => CHARSET[w]).join("")}`;
}

/** NIP-19 `npub1…` or 64 lowercase/uppercase hex → 64 lowercase hex; null otherwise (an `nsec` is never accepted). */
export function parsePubkey(input: string): string | null {
  const value = input.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(value)) return value.toLowerCase();
  const lower = value.toLowerCase();
  if (!lower.startsWith("npub1") || lower !== value) return null;
  const data = [...lower.slice(5)].map((c) => CHARSET.indexOf(c));
  if (data.length < 7 || data.some((d) => d < 0)) return null;
  if (polymod([...hrpExpand("npub"), ...data]) !== 1) return null;
  const words = data.slice(0, -6);
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bytes.length !== 32 || bits >= 5 || acc !== 0) return null;
  return Buffer.from(bytes).toString("hex");
}

/** NIP-98 HTTP auth header value for one request (kind 27235, `u`, `method`, `payload` = sha256 of the body). */
export function nip98Header(secretHex: string, input: { url: string; method: string; body?: string; now?: number }): string {
  const tags = [
    ["u", input.url],
    ["method", input.method.toUpperCase()],
  ];
  if (input.body !== undefined) tags.push(["payload", hex(sha256(new TextEncoder().encode(input.body)))]);
  const event = signEvent(secretHex, { kind: 27235, created_at: input.now ?? Math.floor(Date.now() / 1000), tags, content: "" });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
