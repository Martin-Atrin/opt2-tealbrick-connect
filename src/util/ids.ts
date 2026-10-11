import { createHash, randomBytes } from "node:crypto";

/** App-internal id (`<prefix>_<22 base64url chars>`). Not a CORE `<prefix>_<ULID>` id: those belong to Portal. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
