import { Button, Dialog } from "@opt2-tealbrick/ui";
import { useState } from "react";

import { ConfirmDialog, Notice } from "../components.tsx";
import { copyText, errorText, useLoad } from "../hooks.ts";
import { type BuzzIdentity, buzzAgentRelaysSet, buzzIdentitiesGenerate, buzzIdentitiesList, buzzIdentityRotate, buzzProfilePublish } from "../ops.ts";

function formatCreated(value: number): string {
  const ms = value < 1e12 ? value * 1000 : value;
  return new Date(ms).toLocaleString();
}

export function Buzz() {
  const list = useLoad(buzzIdentitiesList);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [rotating, setRotating] = useState<{ agent: string; name: string } | null>(null);
  const [choosing, setChoosing] = useState<{ agent: string; name: string; relays: string[] | null } | null>(null);

  const relays = list.data?.relays ?? [];
  const relayProblems = list.data?.relayProblems ?? [];

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
      const down = new Set(out.published.flatMap((p) => p.relays.filter((r) => !r.ok).map((r) => r.relay)));
      const parts = [`Published ${out.published.length} profile${out.published.length === 1 ? "" : "s"}.`];
      if (down.size > 0) parts.push(`These relays did not accept all profiles: ${[...down].join(", ")}.`);
      if (out.failed.length > 0) parts.push(`${out.failed.length} agent${out.failed.length === 1 ? "" : "s"} could not publish on any relay.`);
      return parts.join(" ");
    });

  const saveRelays = (target: { agent: string; name: string }, chosen: string[] | null) =>
    run("relays", async () => {
      await buzzAgentRelaysSet(target.agent, chosen);
      return chosen === null ? `${target.name} uses all relays.` : `${target.name} uses ${chosen.length} of ${relays.length} relays.`;
    });

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

      <section aria-labelledby="buzz-relays">
        <h3 id="buzz-relays">Relays</h3>
        {relays.length === 0 ? (
          <p>No relay is set. Set the Buzz relays in Teal Brick Portal, in Connect's settings.</p>
        ) : (
          <>
            <ol className="relay-list">
              {relays.map((r) => (
                <li key={r}>
                  <code>{r}</code>
                </li>
              ))}
            </ol>
            <p className="muted">Agents post to every relay they use and read from all of them. You change the list in Teal Brick Portal, in Connect's settings.</p>
          </>
        )}
        {relayProblems.length > 0 ? (
          <Notice tone="error">
            {relayProblems.map((p) => (
              <span key={p}>
                {p}
                <br />
              </span>
            ))}
          </Notice>
        ) : null}
      </section>

      <div className="row actions">
        <Button type="button" variant="primary" disabled={busy !== null || rows.length === 0} onClick={() => void generate()}>
          Create Buzz identities for all agents
        </Button>
        <Button type="button" variant="secondary" disabled={withIdentity.length === 0} onClick={() => void copyAll()}>
          Copy all npubs
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy !== null || withIdentity.length === 0 || relays.length === 0}
          title={relays.length > 0 ? undefined : "Set the Buzz relays in Connect's settings in Portal first"}
          onClick={() => void publish()}
        >
          Publish profiles
        </Button>
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
                <th scope="col">Relays</th>
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
                  <td data-label="Relays">
                    <span>{relayLabel(row.relays, relays)}</span>{" "}
                    {relays.length > 1 ? (
                      <Button type="button" variant="secondary" size="sm" disabled={busy !== null} onClick={() => setChoosing({ agent: row.agent, name: row.name, relays: row.relays })} aria-label={`Choose relays of ${row.name}`}>
                        Choose
                      </Button>
                    ) : null}
                  </td>
                  <td data-label="">
                    {row.identity ? (
                      <Button type="button" variant="danger" disabled={busy !== null} onClick={() => setRotating({ agent: row.agent, name: row.name })} aria-label={`Replace key of ${row.name}`}>
                        Replace key
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {choosing ? (
        <RelayDialog
          key={choosing.agent}
          name={choosing.name}
          workspace={relays}
          selected={choosing.relays}
          busy={busy !== null}
          onCancel={() => setChoosing(null)}
          onSave={(chosen) => {
            const target = choosing;
            setChoosing(null);
            void saveRelays(target, chosen);
          }}
        />
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
    <Button
      type="button"
      variant="secondary" size="sm"
      aria-label={label}
      onClick={async () => {
        setState((await copyText(text)) ? "copied" : "failed");
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </Button>
  );
}

function relayLabel(selected: string[] | null, workspace: string[]): string {
  if (workspace.length === 0) return "No relay";
  if (selected === null) return workspace.length === 1 ? "The relay" : `All ${workspace.length} relays`;
  const used = workspace.filter((r) => selected.includes(r)).length;
  return used === 0 ? "None (update the choice)" : `${used} of ${workspace.length} relays`;
}

/** Owner choice per agent (C73): all workspace relays (default, includes relays added later) or a subset. */
function RelayDialog(props: { name: string; workspace: string[]; selected: string[] | null; busy: boolean; onCancel(): void; onSave(relays: string[] | null): void }) {
  const [all, setAll] = useState(props.selected === null);
  const [chosen, setChosen] = useState<string[]>(props.selected ?? props.workspace);
  const toggle = (relay: string, on: boolean) => setChosen((prev) => (on ? [...prev, relay] : prev.filter((r) => r !== relay)));
  const picked = props.workspace.filter((r) => chosen.includes(r));
  return (
    <Dialog
      open
      title={`Buzz relays for ${props.name}`}
      onClose={props.onCancel}
      busy={props.busy}
      footer={
        <>
          <Button variant="secondary" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={props.busy || (!all && picked.length === 0)} onClick={() => props.onSave(all ? null : picked)}>
            Save
          </Button>
        </>
      }
    >
      <label className="row">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Use all relays (also relays you add later)
      </label>
      <fieldset disabled={all} className="relay-choices">
        <legend>Relays this agent uses</legend>
        {props.workspace.map((relay) => (
          <label key={relay} className="row">
            <input type="checkbox" checked={all || chosen.includes(relay)} onChange={(e) => toggle(relay, e.target.checked)} /> <code>{relay}</code>
          </label>
        ))}
      </fieldset>
      {!all && picked.length === 0 ? <p className="muted">Choose at least one relay.</p> : null}
    </Dialog>
  );
}
