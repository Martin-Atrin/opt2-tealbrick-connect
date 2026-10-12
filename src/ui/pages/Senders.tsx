// Workspace senders (C86): the identity companion apps (for example Operator Inbox alerts) send from, per channel.
// Agents always send from their own identity; this page never changes that.
import { Button } from "@opt2-tealbrick/ui";
import { useState } from "react";

import { ConfirmDialog, Notice } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type SenderChannel, type SenderInfo, senderIdentitiesList, senderIdentityClear, senderIdentitySet } from "../ops.ts";

const NAMES: Record<SenderChannel, string> = { buzz: "Buzz", slack: "Slack", teams: "Teams", telegram: "Telegram", discord: "Discord" };

export function Senders() {
  const list = useLoad(senderIdentitiesList);
  const [busy, setBusy] = useState<SenderChannel | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [clearing, setClearing] = useState<SenderInfo | null>(null);
  const [label, setLabel] = useState("Workspace");

  const run = async (channel: SenderChannel, action: () => Promise<string>) => {
    setBusy(channel);
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

  const senders = list.data?.senders ?? [];
  const candidates = list.data?.candidates ?? [];

  return (
    <div className="page">
      <h2>Senders</h2>
      <p className="lede">
        Apps such as Operator Inbox send messages from the identity you pick here, one per channel. Agents always send from their own identity. With no
        sender set, apps cannot send on that channel. The first message to a new person still waits for your approval. All apps share one sender per channel: after you approve a first message to a person, every app can write to that person.
      </p>
      {message ? <Notice tone={message.error ? "error" : "info"}>{message.text}</Notice> : null}
      {list.error ? <Notice tone="error">{list.error}</Notice> : null}
      <ul className="stack">
        {senders.map((s) => {
          const bots = candidates.filter((c) => c.service === s.channel);
          return (
            <li key={s.channel} className="card">
              <h3>{NAMES[s.channel]}</h3>
              {s.set ? (
                <p>
                  Apps send as <strong>{s.label}</strong>
                  {s.identity ? <code className="mono"> {s.identity}</code> : null}.
                </p>
              ) : (
                <p className="muted">Not set. Apps cannot send on {NAMES[s.channel]}.</p>
              )}
              {s.channel === "buzz" ? (
                s.set ? null : (
                  <div className="row">
                    <label htmlFor="buzz-sender-label">Display name</label>
                    <input id="buzz-sender-label" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
                    <Button
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        void run("buzz", async () => {
                          const out = await senderIdentitySet({ channel: "buzz", label });
                          return `Created the workspace Buzz identity ${out.sender.identity ?? ""}. Apps send from it now.`;
                        })
                      }
                    >
                      Create Buzz sender
                    </Button>
                  </div>
                )
              ) : bots.length === 0 ? (
                <p className="muted">Connect a {NAMES[s.channel]} bot on the Chat bots page first.</p>
              ) : (
                <div className="row">
                  <label htmlFor={`sender-${s.channel}`}>Bot</label>
                  <select
                    id={`sender-${s.channel}`}
                    value={s.account ?? ""}
                    disabled={busy !== null}
                    onChange={(e) =>
                      void run(s.channel, async () => {
                        const out = await senderIdentitySet({ channel: s.channel, account: e.target.value });
                        return `Apps now send on ${NAMES[s.channel]} as ${out.sender.label ?? "this bot"}.`;
                      })
                    }
                  >
                    <option value="" disabled>
                      Choose a bot
                    </option>
                    {bots.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {s.set ? (
                <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setClearing(s)}>
                  Clear
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={clearing !== null}
        title={`Clear the ${clearing ? NAMES[clearing.channel] : ""} sender`}
        body={
          <p>
            Apps can no longer send on {clearing ? NAMES[clearing.channel] : ""}.
            {clearing?.channel === "buzz" ? " The workspace Buzz identity is deleted. A new one gets a new npub." : ""}
          </p>
        }
        confirmLabel="Clear"
        busy={busy !== null}
        onCancel={() => setClearing(null)}
        onConfirm={() => {
          const target = clearing;
          setClearing(null);
          if (target)
            void run(target.channel, async () => {
              await senderIdentityClear(target.channel);
              return `Cleared. Apps cannot send on ${NAMES[target.channel]}.`;
            });
        }}
      />
    </div>
  );
}
