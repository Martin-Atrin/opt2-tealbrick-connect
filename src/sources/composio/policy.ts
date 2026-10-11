/**
 * Curated per-toolkit policies (harvest: v1 composio-policy.ts). Composio tool names hide writes
 * (`*_PATCH`, `*_WATCH`) and outward actions; a policy pins the class. Order: destructive → outward → writes →
 * reads → name inference. With a policy present, its patterns override name inference (e.g. GMAIL_REMOVE_LABEL
 * is a write, not destructive). Policies are our own labels and ship inside the image.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { classify, inferFromName, type ToolClass } from "../../effect.ts";

export interface ComposioPolicy {
  schema: 1;
  toolkit: string;
  version: string;
  notes?: string;
  destructive: string[];
  outward: string[];
  writes: string[];
  reads: string[];
}

function patternRegex(pattern: string): RegExp {
  const body = pattern
    .trim()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`, "iu");
}

export function matches(patterns: readonly string[], slug: string): boolean {
  return patterns.some((pattern) => patternRegex(pattern).test(slug));
}

export function parsePolicy(raw: unknown): ComposioPolicy {
  const p = raw as Partial<ComposioPolicy>;
  const list = (value: unknown, field: string) => {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)) {
      throw new Error(`policy_invalid: ${field}`);
    }
    return value as string[];
  };
  if (p.schema !== 1 || typeof p.toolkit !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(p.toolkit) || typeof p.version !== "string") {
    throw new Error("policy_invalid: header");
  }
  return {
    schema: 1,
    toolkit: p.toolkit,
    version: p.version,
    ...(typeof p.notes === "string" ? { notes: p.notes } : {}),
    destructive: list(p.destructive, "destructive"),
    outward: list(p.outward, "outward"),
    writes: list(p.writes, "writes"),
    reads: list(p.reads, "reads"),
  };
}

export function loadPolicies(dir = join(import.meta.dirname, "../../../policies/composio")): Map<string, ComposioPolicy> {
  const map = new Map<string, ComposioPolicy>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const policy = parsePolicy(JSON.parse(readFileSync(join(dir, file), "utf8")));
    map.set(policy.toolkit, policy);
  }
  return map;
}

export function classifyComposioTool(slug: string, policy: ComposioPolicy | undefined): ToolClass {
  if (!policy) return inferFromName(slug);
  if (matches(policy.destructive, slug)) return classify({ write: true, outward: false, destructive: true });
  if (matches(policy.outward, slug)) return classify({ write: true, outward: true, destructive: false });
  if (matches(policy.writes, slug)) return classify({ write: true, outward: false, destructive: false });
  if (matches(policy.reads, slug)) return classify({ write: false, outward: false, destructive: false });
  return inferFromName(slug);
}
