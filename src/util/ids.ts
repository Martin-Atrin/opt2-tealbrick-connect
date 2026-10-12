/**
 * Id and digest helpers over `@opt2-tealbrick/manifest` (C21, BSA-13): ULIDs and sha256 digests come from the one
 * primitives package. Only the OAuth/connect `state` value stays local: the manifest's opaque values carry a fixed
 * platform prefix set (OPAQUE_PREFIX), and a third-party `state` must not look like a Teal Brick credential.
 */
import { randomBytes } from "node:crypto";

import { opaqueDigest, ulid } from "@opt2-tealbrick/manifest";

/** App-internal id: `<prefix>_<ULID>` (app data only; not a CORE platform id kind). */
export function newId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/** One-time state for a third-party redirect (32 random bytes, base64url). Store only its digest. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Lowercase hex sha256 of a string (manifest `opaqueDigest`, without the `sha256:` prefix). */
export function sha256Hex(value: string): string {
  return opaqueDigest(value).slice("sha256:".length);
}
