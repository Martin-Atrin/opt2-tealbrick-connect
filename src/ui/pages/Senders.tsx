// Workspace senders (C86): the identity companion apps (for example Operator Inbox alerts) send from, per channel.
// Agents always send from their own identity; this page never changes that.
import { Button, Card, Field, Select, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";

import { ConfirmDialog, LoadError, Notice, PageHead, PageNote, shortId } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type SenderChannel, type SenderInfo, senderIdentitiesList, senderIdentityClear, senderIdentitySet } from "../ops.ts";

const NAMES: Record<SenderChannel, string> = { buzz: "Buzz", slack: "Slack", teams: "Teams", telegram: "Telegram", discord: "Discord" };

/** The identity without its "<channel>:" prefix (the card already names the channel), as the mockup shows it. */
const senderValue = (s: SenderInfo): string => {
  const id = s.identity ?? "";
  return id.startsWith(`${s.channel}:`) ? id.slice(s.channel.length + 1) : id;
};

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
    <section className="app-page" aria-label="Senders">
      <PageHead title="Senders" />
      <PageNote>Apps such as Operator Inbox send messages from the identity you pick here, one per channel. Agents always send from their own identity.</PageNote>
      {message ? <Notice tone={message.error ? "error" : "ok"}>{message.text}</Notice> : null}
      {list.error ? <LoadError message={list.error} busy={list.loading} onRetry={() => void list.reload()} /> : null}
      <ul className="cards">
        {senders.map((s) => {
          const bots = candidates.filter((c) => c.service === s.channel);
          return (
            <li key={s.channel}>
              <Card as="article" className="sender-card">
                <h3>{NAMES[s.channel]}</h3>
                {s.set ? (
                  <p className="tb-soft">
                    Apps send as <strong>{s.label}</strong>
                    {s.identity ? (
                      <>
                        {" "}
                        <code className="tb-mono" title={senderValue(s)}>
                          {shortId(senderValue(s))}
                        </code>
                      </>
                    ) : null}
                    .
                  </p>
                ) : (
                  <p className="tb-hint">Not set. Apps can’t send on {NAMES[s.channel]}.</p>
                )}
                {s.channel === "buzz" ? (
                  s.set ? null : (
                    <>
                      <Field label="Display name">
                        <TextInput value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
                      </Field>
                      <div className="tb-ctas">
                        <Button
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
                    </>
                  )
                ) : bots.length === 0 ? (
                  <p className="tb-hint">Connect a {NAMES[s.channel]} bot on the Chat bots page first.</p>
                ) : (
                  <Field label="Bot">
                    <Select
                      options={bots.map((b) => ({ value: b.id, label: b.label }))}
                      value={s.account ?? ""}
                      placeholder="Choose a bot"
                      disabled={busy !== null}
                      onValueChange={(account) =>
                        account !== s.account &&
                        void run(s.channel, async () => {
                          const out = await senderIdentitySet({ channel: s.channel, account });
                          return `Apps now send on ${NAMES[s.channel]} as ${out.sender.label ?? "this bot"}.`;
                        })
                      }
                    />
                  </Field>
                )}
                {s.set ? (
                  <div className="tb-ctas">
                    <Button size="sm" disabled={busy !== null} onClick={() => setClearing(s)}>
                      Clear
                    </Button>
                  </div>
                ) : null}
              </Card>
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
              return `Cleared. Apps can’t send on ${NAMES[target.channel]}.`;
            });
        }}
      />
    </section>
  );
}
