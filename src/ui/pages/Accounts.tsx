import { Button, Card, Select, TextInput } from "@opt2-tealbrick/ui";
import { type FormEvent, useMemo, useState } from "react";

import { ConfirmDialog, KindBadge, LoadError, Notice, PageHead, ServiceTile, StatusLabel } from "../components.tsx";
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
      setNotice(`“${confirm.label}” is disconnected. Agents lose access to it at once.`);
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
    <section className="app-page" aria-label="Accounts">
      <PageHead title="Accounts" lede="Your connected accounts, and what each agent may do with them. READ/UPDATE includes creating and sending." />
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {accounts.error ? <LoadError message={accounts.error} busy={accounts.loading} onRetry={() => void accounts.reload()} /> : null}
      {accounts.loading && !accounts.data ? (
        <p className="tb-soft" role="status">
          Loading accounts.
        </p>
      ) : null}
      {accounts.data && groups.length === 0 ? <p className="tb-soft">No accounts are connected yet. Open Services to connect one.</p> : null}
      {agents.error ? <LoadError message={`Agents couldn’t be loaded: ${agents.error}`} busy={agents.loading} onRetry={() => void agents.reload()} /> : null}

      {groups.map(([service, list]) => (
        <section key={service} className="tb-stack" aria-labelledby={`svc-${service}`}>
          <div className="group-head">
            <h2 id={`svc-${service}`} className="tb-row">
              <ServiceTile name={service} />
              {service}
            </h2>
            {list.some((a) => a.status === "connected") ? <RefreshTools service={service} /> : null}
          </div>
          {list.some((a) => a.source === "mcp" && a.status === "connected") ? <McpTools service={service} /> : null}
          <ul className="cards cards-wide">
            {list.map((account) => (
              <li key={account.id}>
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
        body={<p>“{confirm?.label}” will be disconnected. Agents lose access to it at once. You can connect it again later.</p>}
        confirmLabel="Disconnect"
        busy={busy}
        onConfirm={() => void disconnect()}
        onCancel={() => setConfirm(null)}
      />
    </section>
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
  if (tools.error) return <LoadError message={`Tools couldn’t be loaded: ${tools.error}`} busy={tools.loading} onRetry={() => void tools.reload()} />;
  if (claimed.length === 0) return null;
  return (
    <Card as="section" className="tool-claims" aria-label="Read-only claims to check">
      <p>
        <strong>Read-only claims to check.</strong> The server says these tools only read. Connect doesn’t trust that claim. Confirm a tool only when you know it
        reads only. A READ agent can then call it.
      </p>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className="tool-list">
        {claimed.map((t) => (
          <li key={t.name} className="tool-row">
            <span>
              {t.title} <span className="tb-muted">({t.ownerConfirmedRead ? "you confirmed: reads only" : `treated as: ${EFFECT_TEXT[t.effect] ?? t.effect}`})</span>
            </span>
            <Button size="sm" disabled={busy === t.name} onClick={() => void set(t, !t.ownerConfirmedRead)} aria-label={`${t.ownerConfirmedRead ? "Withdraw" : "Confirm"} read-only for ${t.title}`}>
              {t.ownerConfirmedRead ? "Withdraw" : "Confirm read-only"}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
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
    <div className="tb-row">
      {state.text ? (
        <span className={state.error ? "inline-error" : "tb-muted"} role={state.error ? "alert" : "status"}>
          {state.text}
        </span>
      ) : null}
      <Button size="sm" onClick={() => void run()} disabled={state.busy} aria-label={`Refresh tools of ${service}`}>
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

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return setError("The label can’t be empty.");
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
    <Card as="article" className="acct">
      {editing ? (
        <form className="tb-input-row" onSubmit={save}>
          <TextInput aria-label="Account label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
          <Button
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
        <div className="acct-head">
          <h3>{account.label}</h3>
          <div className="tb-row acct-tags">
            <StatusLabel status={account.status} />
            <KindBadge kind={account.kind} />
            {account.kind === "as_itself" && props.ownerName ? <span className="tb-muted">{props.ownerName}</span> : null}
          </div>
        </div>
      )}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {account.status === "failed" && account.detail ? <p className="tb-soft">{account.detail}</p> : null}
      {account.status === "connected" ? <AgentAccess account={account} agents={props.agents} /> : null}
      {!editing ? (
        <div className="tb-ctas">
          <Button size="sm" onClick={() => setEditing(true)} aria-label={`Rename ${account.label}`}>
            Rename
          </Button>
          {account.source === "catalog" && account.status === "connected" ? <TestConnection id={account.id} label={account.label} /> : null}
          <Button size="sm" variant="danger" onClick={props.onDisconnect} aria-label={`Disconnect ${account.label}`}>
            Disconnect
          </Button>
        </div>
      ) : null}
    </Card>
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
      <Button size="sm" onClick={() => void run()} disabled={state.busy} aria-label={`Test the connection of ${label}`}>
        Test connection
      </Button>
      {state.text ? (
        <span className={state.error ? "inline-error" : "tb-muted"} role={state.error ? "alert" : "status"}>
          {state.text}
        </span>
      ) : null}
    </>
  );
}

function AgentAccess({ account, agents }: { account: Account; agents: AgentInfo[] }) {
  // Levels set in this session win over the (possibly unknown) list shape.
  const [local, setLocal] = useState<Record<string, Picked>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (agents.length === 0) return <p className="tb-soft">No agents yet. Add an agent in Tealbrick Portal to give it access.</p>;

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
    <fieldset className="tb-stack access">
      <legend className="tb-label access-legend">Agent access</legend>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {agents.map((agent) => (
        <div key={agent.id} className="acc-row">
          <span>{agent.name}</span>
          <Select
            aria-label={`${agent.name} access to ${account.label}`}
            options={LEVEL_OPTIONS}
            value={currentLevel(agent)}
            placeholder="Choose access"
            disabled={busy === agent.id}
            onValueChange={(v) => v !== currentLevel(agent) && void change(agent, v as Picked)}
          />
        </div>
      ))}
    </fieldset>
  );
}
