import { type FormEvent, useEffect, useId, useState } from "react";

import { ConfirmDialog, Notice } from "../components.tsx";
import { copyText, errorText, useLoad } from "../hooks.ts";
import { type BuzzIdentity, buzzIdentitiesGenerate, buzzIdentitiesList, buzzIdentityRotate, buzzProfilePublish, buzzRelaySet } from "../ops.ts";

function formatCreated(value: number): string {
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toLocaleString();
}

export function Buzz() {
  const list = useLoad(buzzIdentitiesList);
  const relayId = useId();
  const [relay, setRelay] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [rotating, setRotating] = useState<{ agent: string; name: string } | null>(null);

  const savedRelay = list.data?.relay ?? "";
  useEffect(() => {
    setRelay(savedRelay);
  }, [savedRelay]);

  const rows = list.data?.agents ?? [];
  const withIdentity = rows.filter((r): r is typeof r & { identity: BuzzIdentity } => r.identity !== null);

  const run = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    setMessage(null);
    try {
      setMessage({ text: await action(), error: false });
      await list.reload();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  };

  const rotate = (target: { agent: string; name: string }) =>
    run("rotate", async () => {
      await buzzIdentityRotate(target.agent);
      return `New Buzz key created for ${target.name}.`;
    });

  const generate = () =>
    run("generate", async () => {
      const out = await buzzIdentitiesGenerate();
      if (out.created.length === 0) return "Every agent already has a Buzz identity.";
      return `Created ${out.created.length} new Buzz identit${out.created.length === 1 ? "y" : "ies"}. ${out.existing.length} already existed.`;
    });

  const publish = () =>
    run("publish", async () => {
      const out = await buzzProfilePublish();
      return `Published ${out.published.length} profile${out.published.length === 1 ? "" : "s"} to the relay.`;
    });

  const saveRelay = (event: FormEvent) => {
    event.preventDefault();
    const value = relay.trim();
    if (!value.startsWith("wss://")) return setMessage({ text: "The relay address must start with wss://.", error: true });
    void run("relay", async () => {
      const out = await buzzRelaySet(value);
      return `Relay saved: ${out.relay ?? value}`;
    });
  };

  const copyAll = async () => {
    const ok = await copyText(withIdentity.map((r) => r.identity.npub).join("\n"));
    setMessage(ok ? { text: `Copied ${withIdentity.length} npub${withIdentity.length === 1 ? "" : "s"}, one per line.`, error: false } : { text: "Copy failed. Select the npubs in the table and copy them by hand.", error: true });
  };

  return (
    <div className="page">
      <h2>Buzz</h2>
      <p className="lede">Each agent gets its own Buzz identity. Add these npubs to your channels in Buzz.</p>
      {message ? <Notice tone={message.error ? "error" : "info"}>{message.text}</Notice> : null}
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}

      <form className="form" onSubmit={saveRelay}>
        <div className="field">
          <label htmlFor={relayId}>Buzz relay address</label>
          <div className="row">
            <input id={relayId} className="grow" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="wss://relay.example.com" inputMode="url" autoComplete="off" spellCheck={false} maxLength={300} />
            <button type="submit" className="btn" disabled={busy !== null}>
              Save relay
            </button>
          </div>
        </div>
      </form>

      <div className="row actions">
        <button type="button" className="btn btn-primary" disabled={busy !== null || rows.length === 0} onClick={() => void generate()}>
          Create Buzz identities for all agents
        </button>
        <button type="button" className="btn" disabled={withIdentity.length === 0} onClick={() => void copyAll()}>
          Copy all npubs
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || withIdentity.length === 0 || !savedRelay}
          title={savedRelay ? undefined : "Save the relay address first"}
          onClick={() => void publish()}
        >
          Publish profiles
        </button>
      </div>

      {list.loading && !list.data ? <p className="muted">Loading agents.</p> : null}
      {list.data && rows.length === 0 ? <p className="muted">No agents yet. Add an agent in Teal Brick Portal first.</p> : null}

      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">npub</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.agent}>
                  <td data-label="Agent">{row.name}</td>
                  <td data-label="npub">
                    {row.identity ? (
                      <div className="npub-cell">
                        <code className="npub">{row.identity.npub}</code>
                        <CopyButton text={row.identity.npub} label={`Copy npub of ${row.name}`} />
                      </div>
                    ) : (
                      <span className="muted">No identity yet</span>
                    )}
                  </td>
                  <td data-label={row.identity ? "Created" : ""}>{row.identity ? formatCreated(row.identity.createdAt) : ""}</td>
                  <td data-label="">
                    {row.identity ? (
                      <button type="button" className="btn btn-danger-outline" disabled={busy !== null} onClick={() => setRotating({ agent: row.agent, name: row.name })} aria-label={`Replace key of ${row.name}`}>
                        Replace key
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <ConfirmDialog
        open={rotating !== null}
        title="Replace this Buzz key?"
        body={<p>{rotating?.name} gets a new Buzz identity. The old key stops working, and you must add the new npub to your channels in Buzz again.</p>}
        confirmLabel="Replace key"
        busy={busy !== null}
        onCancel={() => setRotating(null)}
        onConfirm={() => {
          const target = rotating;
          setRotating(null);
          if (target) void rotate(target);
        }}
      />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      className="btn btn-small"
      aria-label={label}
      onClick={async () => {
        setState((await copyText(text)) ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}
