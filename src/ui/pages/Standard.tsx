/**
 * The SDK standard pages (SDK-API §6/§14, ui STANDARD_PAGES): Holds, Receipts, Agents & scopes, Keys, Backups & export.
 * All data comes from the SDK client hooks and the standard person ops; Connect adds no state of its own here.
 */
import { useAgents, useHolds } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";

import { Notice } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { callOp, tbFetch } from "../sdk.ts";

type ReceiptRow = { id: string; caller: { name: string }; op: string; effect: string; status: string; summary: string; createdAt: number };
type KeyRow = { name: string; required: boolean; present: boolean; source: string | null };

const when = (ms: number) => new Date(ms).toLocaleString();

export function Holds() {
  const { holds, loading, decide } = useHolds({ status: "held" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (loading) return <p>Loading holds.</p>;
  const act = async (id: string, decision: "approve" | "deny") => {
    setBusy(id);
    setError(null);
    try {
      await decide(id as Parameters<typeof decide>[0], decision);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section aria-labelledby="holds-title">
      <h2 id="holds-title">Holds</h2>
      <p>Calls that wait for your approval. Each approval allows that one call only.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {holds.length === 0 ? <p>No calls wait for your approval.</p> : null}
      <ul className="list">
        {holds.map((h) => (
          <li key={h.id} className="card">
            <p>
              <strong>{h.caller.name}</strong> {h.summary} <Tag tone="action">{h.op}</Tag>
            </p>
            {h.view ? <pre className="hold-view">{h.view}</pre> : null}
            <div className="row">
              <Button variant="primary" disabled={busy === h.id} onClick={() => void act(h.id, "approve")}>
                Approve
              </Button>
              <Button variant="secondary" disabled={busy === h.id} onClick={() => void act(h.id, "deny")}>
                Deny
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Receipts() {
  const list = useLoad(() => callOp<{ items: ReceiptRow[] }>("tb.receipts_list", {}));
  return (
    <section aria-labelledby="receipts-title">
      <h2 id="receipts-title">Receipts</h2>
      <p>What your agents did through Connect. Inputs are kept only as digests.</p>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      {list.data && list.data.items.length === 0 ? <p>No receipts yet.</p> : null}
      <ul className="list">
        {(list.data?.items ?? []).map((r) => (
          <li key={r.id} className="card">
            <strong>{r.caller.name}</strong> {r.summary} <Tag tone="neutral">{r.status}</Tag> <small>{when(r.createdAt)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Agents() {
  const { agents, loading } = useAgents();
  if (loading) return <p>Loading agents.</p>;
  return (
    <section aria-labelledby="agents-title">
      <h2 id="agents-title">Agents &amp; scopes</h2>
      <p>Agents connected to Connect. Set each agent's access per account on the Accounts page.</p>
      {agents.length === 0 ? <p>No agents are connected to Connect yet. Draw a line from an agent to Connect on the Portal canvas.</p> : null}
      <ul className="list">
        {agents.map((a) => (
          <li key={a.id} className="card">
            <strong>{a.name}</strong> <Tag tone={a.status === "active" ? "ok" : "blocked"}>{a.status === "active" ? "Active" : "Paused"}</Tag>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Keys() {
  const list = useLoad(() => callOp<{ keys: KeyRow[] }>("tb.keys_status", {}));
  return (
    <section aria-labelledby="keys-title">
      <h2 id="keys-title">Keys</h2>
      <p>Connect never shows key values. Add or replace workspace keys on the key page that Teal Brick Portal opens for Connect.</p>
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      <ul className="list">
        {(list.data?.keys ?? []).map((k) => (
          <li key={k.name} className="card">
            <code>{k.name}</code> <Tag tone={k.present ? "ok" : k.required ? "action" : "neutral"}>{k.present ? "Set" : "Not set"}</Tag>
            {k.source ? <small> ({k.source === "app_own" ? "Connect key" : "workspace key"})</small> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Backups() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await tbFetch("tb/v1/ops/tb.export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
      const name = /filename="([^"]+)"/u.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "connect-export.tar.gz";
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="backups-title">
      <h2 id="backups-title">Backups &amp; export</h2>
      <p>Connect backs up its data every night to its own volume. Export gives you a readable copy (no secret values).</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>
        Download export
      </Button>
    </section>
  );
}
