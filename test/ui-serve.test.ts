/**
 * The built app (what the image runs: `node dist/main.js`) serves the manifest's `ui` paths to a signed-in person
 * (QA S1 regression guard). Builds dist/ if missing, boots app-alone mode on a temp data dir, signs in through the
 * standalone flow, then GETs ui.launchPath, ui.configurePath and the UI assets.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { root } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(root, "tealbrick.manifest.json"), "utf8")) as {
  id: string;
  runtime: { port: number };
  ui: { launchPath: string; configurePath?: string };
};
const origin = `http://127.0.0.1:${manifest.runtime.port}`;
const base = `/a/${manifest.id}`;

test("built image layout serves ui.launchPath, ui.configurePath and assets to a signed-in person", { timeout: 120_000 }, async () => {
  if (!existsSync(join(root, "dist", "main.js")) || !existsSync(join(root, "dist", "ui", "index.html"))) {
    execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "ignore" });
    execFileSync(process.execPath, ["scripts/build-ui.ts"], { cwd: root, stdio: "ignore" });
  }
  const data = mkdtempSync(join(tmpdir(), "connect-ui-serve-"));
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", TB_STANDALONE: "1", TB_DATA_DIR: data, TB_BACKUP_DIR: join(data, "backup") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let out = "";
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no setup code in output: ${out.slice(0, 500)}`)), 30_000);
      const onData = (chunk: Buffer) => {
        out += chunk.toString();
        const m = /([0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5})/u.exec(out);
        if (m && /app started/u.test(out)) {
          clearTimeout(timer);
          resolve(m[1] as string);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("exit", (c) => reject(new Error(`app exited ${c}: ${out.slice(0, 500)}`)));
    });
    const signIn = await fetch(`${origin}${base}/tb/standalone`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ code, passphrase: "ui-serve-test-passphrase" }).toString(),
    });
    assert.equal(signIn.status, 303);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.match(cookie, /^tb_session=/u);
    const get = (path: string) => fetch(`${origin}${base}${path}`, { headers: { cookie } });
    for (const path of [manifest.ui.launchPath, manifest.ui.configurePath ?? manifest.ui.launchPath]) {
      const res = await get(path);
      assert.equal(res.status, 200, `${path} → ${res.status}`);
      assert.match(await res.text(), /<div id="root">/u, path);
    }
    for (const asset of ["/main.js", "/ops.json", "/app.css"]) assert.equal((await get(asset)).status, 200, asset);
    assert.equal((await fetch(`${origin}${base}${manifest.ui.launchPath}`)).status, 401, "no session → sign-in page");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(data, { recursive: true, force: true });
  }
});
