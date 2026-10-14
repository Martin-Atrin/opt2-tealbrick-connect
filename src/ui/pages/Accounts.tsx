import { Button } from "@opt2-tealbrick/ui";
import { type FormEvent, useId, useMemo, useState } from "react";

import { ConfirmDialog, KindBadge, Notice, StatusLabel } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import {
  type AccessLevel,
  type Account,
  type AgentInfo,
  accountDisconnect,
  accountsOverview,
  accountUpdate,
  agentsList,
  catalogAccountTest,
  type McpToolRow,
  mcpToolReadSet,
  mcpToolsList,
  scopesSet,
  toolsRefresh,
} from "../ops.ts";

type Picked = AccessLevel | "none";

const LEVEL_OPTIONS: { value: Picked; label: string }[] = [
  { value: "none", label: "None" },
  { value: "read", label: "READ" },
  { value: "read_update", label: "READ/UPDATE" },
  { value: "read_update_delete", label: "READ/UPDATE/DELETE" },
];

export function Accounts() {
  const accounts = useLoad(accountsOverview);
  const agents = useLoad(agentsList);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => {
    const byService = new Map<string, Account[]>();
    for (const account of accounts.data?.accounts ?? []) {
      if (account.status === "revoked") continue;
      byService.set(account.service, [...(byService.get(account.service) ?? []), account]);
    }
    return [...byService.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [accounts.data]);

  const agentName = (id: string | null) => agents.data?.find((a) => a.id === id)?.name ?? id ?? "";

  const disconnect = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      await accountDisconnect(confirm.id);
      setNotice(`"${confirm.label}" is disconnected. Agents lose access to it at once.`);
      setConfirm(null);
      await accounts.reload();
    } catch (e) {
      setError(errorText(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h2>Accounts</h2>
      <p className="lede">Your connected accounts, and what each agent may do with them. READ/UPDATE includes creating and sending.</p>
      {notice ? <Notice>{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {accounts.error ? <Notice tone="error">{accounts.error}</Notice> : null}
      {accounts.loading && !accounts.data ? <p className="muted">Loading accounts.</p> : null}
      {accounts.data && groups.length === 0 ? <p className="muted">No accounts are connected yet. Open Services to connect one.</p> : null}
      {agents.error ? <Notice tone="error">Agents could not be loaded: {agents.error}</Notice> : null}

      {groups.map(([service, list]) => (
        <section key={service} className="group" aria-labelledby={`svc-${service}`}>
          <div className="group-head">
            <h3 id={`svc-${service}`}>{service}</h3>
            {list.some((a) => a.status === "connected") ? <RefreshTools service={service} /> : null}
          </div>
          {list.some((a) => a.source === "mcp" && a.status === "connected") ? <McpTools service={service} /> : null}
          <ul className="stack">
            {list.map((account) => (
              <li key={account.id} className="card">
                <AccountRow
                  account={account}
                  ownerName={agentName(account.ownerAgent)}
                  agents={agents.data ?? []}
                  onRenamed={() => {
                    setNotice(null);
                    void accounts.reload();
                  }}
                  onDisconnect={() => setConfirm(account)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}

      <ConfirmDialog
        open={confirm !== null}
        title="Disconnect this account?"
        body={<p>"{confirm?.label}" will be disconnected. Agents lose access to it at once. You can connect it again later.</p>}
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

const EFFECT_TEXT: Record<string, string> = {
  read: "reads only",
  write: "changes data",
  outward: "sends or publishes",
  destructive: "deletes",
  money: "moves money",
};

/**
 * X-03: an MCP server can only CLAIM that a tool is read-only. Connect treats such a tool by its name (usually a write)
 * until the owner confirms the claim here. Only tools with an unverified claim can be confirmed.
 */
function McpTools({ service }: { service: string }) {
  const tools = useLoad(() => mcpToolsList(service), service);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claimed = (tools.data?.tools ?? []).filter((t) => t.unverifiedReadClaim);
  const set = async (tool: McpToolRow, read: boolean) => {
    setBusy(tool.name);
    setError(null);
    try {
      await mcpToolReadSet(tool.name, read);
      await tools.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  if (tools.error) return <Notice tone="error">Tools could not be loaded: {tools.error}</Notice>;
  if (claimed.length === 0) return null;
  return (
    <div className="card">
      <p>
        <strong>Read-only claims to check.</strong> The server says these tools only read. Connect does not trust that claim. Confirm a tool only when you know it
        reads only. A READ agent can then call it.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className="stack">
        {claimed.map((t) => (
          <li key={t.name} className="row">
            <span>
              {t.title} <span className="muted">({t.ownerConfirmedRead ? "you confirmed: reads only" : `treated as: ${EFFECT_TEXT[t.effect] ?? t.effect}`})</span>
            </span>
            <Button type="button" variant="secondary" disabled={busy === t.name} onClick={() => void set(t, !t.ownerConfirmedRead)} aria-label={`${t.ownerConfirmedRead ? "Withdraw" : "Confirm"} read-only for ${t.title}`}>
              {t.ownerConfirmedRead ? "Withdraw" : "Confirm read-only"}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefreshTools({ service }: { service: string }) {
  const [state, setState] = useState<{ busy: boolean; text: string | null; error: boolean }>({ busy: false, text: null, error: false });
  const run = async () => {
    setState({ busy: true, text: null, error: false });
    try {
      await toolsRefresh(service);
      setState({ busy: false, text: "Tools refreshed.", error: false });
    } catch (e) {
      setState({ busy: false, text: errorText(e), error: true });
    }
  };
  return (
    <div className="row">
      {state.text ? <span className={state.error ? "inline-error" : "muted"}>{state.text}</span> : null}
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={state.busy} aria-label={`Refresh tools of ${service}`}>
        Refresh tools
      </Button>
    </div>
  );
}

function AccountRow(props: { account: Account; ownerName: string; agents: AgentInfo[]; onRenamed(): void; onDisconnect(): void }) {
  const { account } = props;
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return setError("The label cannot be empty.");
    setBusy(true);
    setError(null);
    try {
      await accountUpdate(account.id, label.trim());
      setEditing(false);
      props.onRenamed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card-head">
        {editing ? (
          <form className="row grow" onSubmit={save}>
            <label htmlFor={labelId} className="visually-hidden">
              Account label
            </label>
            <input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required />
            <Button type="submit" variant="primary" disabled={busy}>
              Save
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setLabel(account.label);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <h4 className="card-title">{account.label}</h4>
            <div className="row">
              <StatusLabel status={account.status} />
              <KindBadge kind={account.kind} />
              {account.kind === "as_itself" && props.ownerName ? <span className="muted">{props.ownerName}</span> : null}
            </div>
          </>
        )}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {account.status === "failed" && account.detail ? <p className="muted">{account.detail}</p> : null}
      {!editing ? (
        <div className="row">
          <Button type="button" variant="secondary" onClick={() => setEditing(true)} aria-label={`Rename ${account.label}`}>
            Rename
          </Button>
          {account.source === "catalog" && account.status === "connected" ? <TestConnection id={account.id} label={account.label} /> : null}
          <Button type="button" variant="danger" onClick={props.onDisconnect} aria-label={`Disconnect ${account.label}`}>
            Disconnect
          </Button>
        </div>
      ) : null}
      {account.status === "connected" ? <AgentAccess account={account} agents={props.agents} /> : null}
    </>
  );
}

function TestConnection({ id, label }: { id: string; label: string }) {
  const [state, setState] = useState<{ busy: boolean; text: string | null; error: boolean }>({ busy: false, text: null, error: false });
  const run = async () => {
    setState({ busy: true, text: null, error: false });
    try {
      const out = await catalogAccountTest(id);
      setState({ busy: false, text: out.ok ? "Connection works." : out.detail, error: !out.ok });
    } catch (e) {
      setState({ busy: false, text: errorText(e), error: true });
    }
  };
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => void run()} disabled={state.busy} aria-label={`Test the connection of ${label}`}>
        Test connection
      </Button>
      {state.text ? <span className={state.error ? "inline-error" : "muted"}>{state.text}</span> : null}
    </>
  );
}

function AgentAccess({ account, agents }: { account: Account; agents: AgentInfo[] }) {
  // Levels set in this session win over the (possibly unknown) list shape.
  const [local, setLocal] = useState<Record<string, Picked>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (agents.length === 0) return <p className="muted">No agents yet. Add an agent in Teal Brick Portal to give it access.</p>;

  const currentLevel = (agent: AgentInfo): Picked | "" => local[agent.id] ?? (agent.levels ? (agent.levels[account.id] ?? "none") : "");

  const change = async (agent: AgentInfo, value: Picked) => {
    setBusy(agent.id);
    setError(null);
    try {
      await scopesSet(agent.id, account.id, value === "none" ? null : value);
      setLocal((l) => ({ ...l, [agent.id]: value }));
    } catch (e) {
      setError(`${agent.name}: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <fieldset className="access">
      <legend>Agent access</legend>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className="stack">
        {agents.map((agent) => {
          const selectId = `${account.id}-${agent.id}`;
          const value = currentLevel(agent);
          return (
            <li key={agent.id} className="access-row">
              <label htmlFor={selectId}>{agent.name}</label>
              <select id={selectId} value={value} disabled={busy === agent.id} onChange={(e) => void change(agent, e.target.value as Picked)}>
                {value === "" ? (
                  <option value="" disabled>
                    Choose access
                  </option>
                ) : null}
                {LEVEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
