/**
 * The ONLY file of the Connect UI that talks to the network: the Miniapp SDK client (`@opt2-tealbrick/miniapp-sdk/client`).
 * Which person ops need an idempotency key comes from the manifest (dist/ui/ops.json, written by scripts/build-ui.ts),
 * never from a hand-copied list (BSA-08). Remove this lookup when the SDK client adds keys itself (BSA-12).
 */
import { callOp as sdkCallOp, TbError, tbFetch, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import type { Json } from "@opt2-tealbrick/spec/sdk";

export type { Json };
export { TbError, tbFetch, useSession };

type OpFacts = { operations: { id: string; idempotency: string }[] };

/** Ids of the ops whose manifest `idempotency` is `required`. */
export function requiredIdempotency(facts: OpFacts): ReadonlySet<string> {
  return new Set(facts.operations.filter((o) => o.idempotency === "required").map((o) => o.id));
}

let facts: Promise<ReadonlySet<string>> | null = null;
function idempotentOps(): Promise<ReadonlySet<string>> {
  facts ??= fetch("./ops.json", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<OpFacts>) : Promise.reject(new TbError("ops_facts_missing", "ops.json is missing", r.status))))
    .then(requiredIdempotency);
  return facts;
}

/** Call options for a person op: a fresh idempotency key when the manifest requires one. */
export function opOptions(op: string, required: ReadonlySet<string>): { idempotencyKey?: string } {
  return required.has(op) ? { idempotencyKey: globalThis.crypto.randomUUID() } : {};
}

export async function callOp<O = Json>(op: string, input: Json): Promise<O> {
  return sdkCallOp<O>(op, input, opOptions(op, await idempotentOps()));
}
