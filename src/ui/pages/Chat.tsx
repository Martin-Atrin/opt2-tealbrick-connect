/** Chat bots (C58): connect a Slack, Teams, Telegram or Discord bot for one agent; see inbound status. */
import { Button, Tag } from "@opt2-tealbrick/ui";
import { type FormEvent, useId, useState } from "react";

import { Notice, StatusLabel } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type ChannelProviderInfo, channelAccountConnect, channelAccounts, channelProviders } from "../ops.ts";

const NAMES: Record<ChannelProviderInfo["service"], string> = { slack: "Slack", teams: "Microsoft Teams", telegram: "Telegram", discord: "Discord" };
const HELP: Record<ChannelProviderInfo["service"], string> = {
  slack: "Create a Slack app with Socket Mode on, install it, then paste the bot token (xoxb-…) and the app-level token (xapp-…, scope connections:write).",
  teams: "Create a single-tenant Azure Bot. Set its messaging endpoint to your workspace door: https://<bridge>/p/connect/inbound/teams.",
  telegram: "Create a bot with @BotFather and paste its token. People must start a chat with the bot before it can message them.",
  discord: "Create a bot in the Discord developer portal, invite it to your server, paste its token.",
};
const label = (field: string) => field.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());

export function Chat() {
  const providers = useLoad(channelProviders);
  const accounts = useLoad(channelAccounts);
  const [service, setService] = useState<ChannelProviderInfo["service"] | null>(null);
  const picked = providers.data?.services.find((p) => p.service === service) ?? null;
  return (
    <section aria-labelledby="chat-title">
      <h2 id="chat-title">Chat bots</h2>
      <p>Give an agent its own bot on Slack, Teams, Telegram or Discord. Messages to the bot reach the agent's inbox; set the agent's access to the bot on the Accounts page.</p>
      {providers.error ? <Notice tone="error">{providers.error}</Notice> : null}
      <div className="row">
        {(providers.data?.services ?? []).map((p) => (
          <Button key={p.service} variant={service === p.service ? "primary" : "secondary"} onClick={() => setService(p.service)}>
            {NAMES[p.service]}
          </Button>
        ))}
      </div>
      {picked ? (
        <ConnectForm
          provider={picked}
          agents={providers.data?.agents ?? []}
          onDone={() => {
            setService(null);
            void accounts.reload();
          }}
        />
      ) : null}
      <h3>Connected bots</h3>
      {accounts.error ? <Notice tone="error">{accounts.error}</Notice> : null}
      {accounts.data && accounts.data.accounts.length === 0 ? <p>No chat bots yet.</p> : null}
      <ul className="list">
        {(accounts.data?.accounts ?? []).map((a) => (
          <li key={a.id} className="card">
            <strong>{a.label}</strong> <Tag tone="neutral">{NAMES[a.service as ChannelProviderInfo["service"]] ?? a.service}</Tag> <StatusLabel status={a.status} />
            {a.bot ? (
              <p className="muted">
                Bot {a.bot.name}. Inbound: {a.bot.inbound}
                {a.bot.detail ? ` (${a.bot.detail})` : ""}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ConnectForm(props: { provider: ChannelProviderInfo; agents: { id: string; name: string }[]; onDone(): void }) {
  const id = useId();
  const [labelText, setLabel] = useState(NAMES[props.provider.service]);
  const [agent, setAgent] = useState(props.agents[0]?.id ?? "");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<Record<string, string | boolean>>(Object.fromEntries(props.provider.settingFields.map((f) => [f.key, f.default])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await channelAccountConnect({ service: props.provider.service, label: labelText, agent, credentials: creds, settings });
      props.onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form card" onSubmit={(e) => void submit(e)}>
      <p className="muted">{HELP[props.provider.service]}</p>
      <div className="field">
        <label htmlFor={`${id}-label`}>Name</label>
        <input id={`${id}-label`} value={labelText} onChange={(e) => setLabel(e.target.value)} maxLength={60} required />
      </div>
      <div className="field">
        <label htmlFor={`${id}-agent`}>Agent this bot speaks for</label>
        <select id={`${id}-agent`} value={agent} onChange={(e) => setAgent(e.target.value)} required>
          {props.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>
      {props.provider.credentialFields.map((f) => (
        <div className="field" key={f}>
          <label htmlFor={`${id}-${f}`}>{label(f)}</label>
          <input id={`${id}-${f}`} type="password" autoComplete="off" value={creds[f] ?? ""} onChange={(e) => setCreds({ ...creds, [f]: e.target.value })} required />
        </div>
      ))}
      {props.provider.settingFields.map((f) =>
        f.type === "boolean" ? (
          <label key={f.key} className="row">
            <input type="checkbox" checked={settings[f.key] === true || settings[f.key] === "true"} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.checked })} /> {f.label}
          </label>
        ) : null,
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" variant="primary" disabled={busy || !agent}>
        Connect bot
      </Button>
    </form>
  );
}
