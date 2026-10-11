/**
 * The ONLY file of the Connect UI that talks to the network: the Miniapp SDK client (`@opt2-tealbrick/miniapp-sdk/client`).
 * One local addition: person ops with `idempotency: "required"` (crud create) need an idempotency key, which the
 * SDK client's `callOp(op, input)` cannot send yet (REQUESTS `## connect: callOp idempotency key`). Those ops use the
 * SDK's own `tbFetch` with the documented body `{ input, idempotencyKey }` and the same `{ status, output }` answer.
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

/** The body of a person op: `{ input }`, plus a fresh idempotency key for create ops. */
export function buildOpBody(op: string, input: Json): { input: Json; idempotencyKey?: string } {
  return CREATE_OPS.has(op) ? { input, idempotencyKey: globalThis.crypto.randomUUID() } : { input };
}

export async function callOp<O = Json>(op: string, input: Json): Promise<O> {
  if (!CREATE_OPS.has(op)) return sdkCallOp<O>(op, input);
  const res = await tbFetch(`tb/v1/ops/${encodeURIComponent(op)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(buildOpBody(op, input)),
  });
  const answer = (await res.json()) as { status?: string; output?: O };
  if (answer?.status === "ok") return answer.output as O;
  throw new TbError("op_not_completed", `operation ${op} did not complete (status ${String(answer?.status)})`, 502);
}
