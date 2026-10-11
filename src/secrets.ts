/**
 * Sealed app secrets (connector API keys, OAuth tokens, Buzz agent secret keys): AES-256-GCM with a key derived
 * by HKDF-SHA256 from the instance KEK (`TB_KEK`, CORE §10 / SDK-API §13) and AAD = the secret name, so a
 * ciphertext cannot be moved between rows (fixes v1 store.ts:101). Values are never logged or returned to callers
 * beyond the code that uses them. Pending SDK request: `ctx.seal/open` would replace the KEK derivation here.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type { Db } from "@opt2-tealbrick/spec/sdk";

import { sha256Hex } from "./util/ids.ts";

const FORMAT = "v1";

export function parseKek(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) throw new Error("kek_missing");
  const bytes = /^[0-9a-f]{64}$/iu.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64url");
  if (bytes.length !== 32) throw new Error("kek_invalid");
  return bytes;
}

export class SecretBox {
  readonly #key: Buffer;

  constructor(kek: Buffer) {
    this.#key = Buffer.from(hkdfSync("sha256", kek, Buffer.alloc(0), "tealbrick/connect/app-secrets/v1", 32));
  }

  seal(name: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(name, "utf8"));
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [FORMAT, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(name: string, sealed: string): string {
    const [format, iv, tag, body] = sealed.split(".");
    if (format !== FORMAT || !iv || !tag || body === undefined) throw new Error("secret_format_invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}

/** Short non-reversible fingerprint shown in the UI ("configured, …a1b2c3"). */
export function fingerprint(value: string): string {
  return sha256Hex(value).slice(0, 12);
}

export class SecretStore {
  readonly #db: Db;
  readonly #box: SecretBox;

  constructor(db: Db, box: SecretBox) {
    this.#db = db;
    this.#box = box;
  }

  put(name: string, value: string, now = Date.now()): void {
    this.#db
      .prepare(
        `INSERT INTO connect_secrets (name, sealed, fingerprint, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
      )
      .run(name, this.#box.seal(name, value), fingerprint(value), now);
  }

  get(name: string): string | null {
    const row = this.#db.prepare("SELECT sealed FROM connect_secrets WHERE name = ?").get(name);
    return row ? this.#box.open(name, String(row.sealed)) : null;
  }

  has(name: string): boolean {
    return this.#db.prepare("SELECT 1 FROM connect_secrets WHERE name = ?").get(name) !== undefined;
  }

  delete(name: string): void {
    this.#db.prepare("DELETE FROM connect_secrets WHERE name = ?").run(name);
  }

  deletePrefix(prefix: string): void {
    this.#db.prepare("DELETE FROM connect_secrets WHERE substr(name, 1, ?) = ?").run(prefix.length, prefix);
  }
}
