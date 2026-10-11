import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { addForbiddenPatterns, buildBundle, findForbidden, writeBundle } from "../scripts/catalog-build.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture(entry: Record<string, unknown>, spec: string) {
  const dir = mkdtempSync(join(tmpdir(), "connect-catalog-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(join(dir, "demo", "openapi.json"), spec);
  writeFileSync(join(dir, "demo", "entry.json"), JSON.stringify(entry));
  writeFileSync(join(dir, "demo", "PROVENANCE.md"), "captured from https://demo.my-tailnet.ts.net");
  return dir;
}

test("build scrubs home-infrastructure values, drops provenance, is deterministic", () => {
  const spec = JSON.stringify({ openapi: "3.1.0", paths: {} });
  const dir = fixture(
    { schema: 1, id: "demo", source: "openapi", openapi: { spec: "openapi.json", sha256: sha(spec) }, baseUrlExample: "https://box.my-tailnet.ts.net:8443", app: { specSource: "https://box.my-tailnet.ts.net/api/openapi.json" } },
    spec,
  );
  try {
    const bundle = buildBundle(dir, "0.0.1");
    const entry = bundle.entries[0]?.entry as { baseUrlExample: string; app: { specSource: string } };
    assert.equal(entry.baseUrlExample, "https://demo.example.com");
    assert.equal(entry.app.specSource, "instance-capture");
    assert.equal(bundle.entries[0]?.files.map((f) => f.name).join(), "openapi.json");
    const out = join(dir, "out");
    const a = writeBundle(bundle, out);
    const b = writeBundle(buildBundle(dir, "0.0.1"), out);
    assert.equal(a.sha256, b.sha256);
    assert.equal(findForbidden(gunzipSync(readFileSync(a.file)).toString("utf8")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator-specific host patterns can be added at build time", () => {
  addForbiddenPatterns("# private list\n\\bbox-17\\b\n");
  assert.equal(findForbidden("https://box-17.example.test"), "\\bbox-17\\b");
});

test("build refuses a spec that does not match its pin, and personal hosts inside a spec", () => {
  const spec = JSON.stringify({ openapi: "3.1.0" });
  const bad = fixture({ schema: 1, id: "demo", source: "openapi", openapi: { spec: "openapi.json", sha256: "0".repeat(64) } }, spec);
  const leaky = JSON.stringify({ servers: [{ url: "https://box.my-tailnet.ts.net" }] });
  const leak = fixture({ schema: 1, id: "demo", source: "openapi", openapi: { spec: "openapi.json", sha256: sha(leaky) } }, leaky);
  try {
    assert.throws(() => buildBundle(bad, "0.0.1"), /does not match pin/u);
    assert.throws(() => buildBundle(leak, "0.0.1"), /personal host pattern/u);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(leak, { recursive: true, force: true });
  }
});

const V1 = join(import.meta.dirname, "..", "..", "_v1", "marketplace", "program", "catalog", "company-box");
test("v1 Company Box builds into the pinned 0.1.0 artifact (local only)", { skip: !existsSync(V1) }, () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "tealbrick.manifest.json"), "utf8"));
  const pinned = manifest.artifacts.find((a: { id: string }) => a.id === "catalog");
  const dir = mkdtempSync(join(tmpdir(), "connect-catalog-v1-"));
  try {
    const bundle = buildBundle(V1, pinned.version);
    assert.equal(bundle.entries.length, 12);
    assert.equal(writeBundle(bundle, dir).sha256, pinned.sha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
