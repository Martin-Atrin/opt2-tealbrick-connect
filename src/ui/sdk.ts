/**
 * The ONLY file of the Connect UI that talks to the network: the Miniapp SDK client (`@opt2-tealbrick/miniapp-sdk/client`).
 * Person ops with `idempotency: "required"` (crud create) get a fresh idempotency key per user action (C41).
 */
import { callOp as sdkCallOp, TbError, tbFetch, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import type { Json } from "@opt2-tealbrick/spec/sdk";

export type { Json };
export { TbError, tbFetch, useSession };

/** Person ops of `crud: ["create"]` (manifest `idempotency: "required"`, SDK-API §4.4). */
export const CREATE_OPS: ReadonlySet<string> = new Set([
  "account_connect",
  "catalog_account_connect",
  "mcp_account_connect",
  "buzz_identities_generate",
  "buzz_profile_publish",
]);

/** Call options for a person op: a fresh idempotency key for create ops, none otherwise. */
export function opOptions(op: string): { idempotencyKey?: string } {
  return CREATE_OPS.has(op) ? { idempotencyKey: globalThis.crypto.randomUUID() } : {};
}

export function callOp<O = Json>(op: string, input: Json): Promise<O> {
  return sdkCallOp<O>(op, input, opOptions(op));
}
