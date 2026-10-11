import { Button } from "@opt2-tealbrick/ui";
import { type FormEvent, useEffect, useId, useState } from "react";

import { Notice } from "../components.tsx";
import { errorText, useLoad } from "../hooks.ts";
import { type AccountKind, accountConnect, accountsOverview, agentsList, catalogAccountConnect, type ServiceHit, servicesSearch } from "../ops.ts";

const POLL_MS = 2000;
const POLL_MAX_MS = 5 * 60 * 1000;

interface Watch {
  accountId: string;
  label: string;
  redirectUrl: string;
  phase: "waiting" | "connected" | "failed" | "timeout";
  detail: string;
}

export function Services(props: { onOpenAccounts(): void }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [watch, setWatch] = useState<Watch | null>(null);
  const searchId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useLoad(() => servicesSearch(debounced), debounced);

  // Watch a started connection: poll the account list every 2 s (max 5 min) and re-check at once on a popup message.
  const watchedId = watch?.phase === "waiting" ? watch.accountId : null;
  useEffect(() => {
    if (!watchedId) return;
    const started = Date.now();
    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      let done = false;
      try {
        const account = (await accountsOverview()).accounts.find((a) => a.id === watchedId);
        if (account && (account.status === "connected" || account.status === "failed") && !stopped) {
          done = true;
          setWatch((w) => (w && w.accountId === watchedId ? { ...w, phase: account.status === "connected" ? "connected" : "failed", detail: account.detail } : w));
        }
      } catch {
        // a failed poll is retried on the next tick
      }
      inFlight = false;
      if (done || stopped) return;
      if (Date.now() - started >= POLL_MAX_MS) {
        setWatch((w) => (w && w.accountId === watchedId ? { ...w, phase: "timeout" } : w));
        return;
      }
      timer = setTimeout(() => void check(), POLL_MS);
    };
    // The popup posts { connect: true | false }; the answer only triggers a check, the server state decides.
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "object" && event.data !== null && "connect" in event.data) {
        clearTimeout(timer);
        void check();
      }
    };
    window.addEventListener("message", onMessage);
    timer = setTimeout(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [watchedId]);

  return (
    <div className="page">
      <h2>Services</h2>
      <p className="lede">Search the services you can connect, then sign in to your account of that service.</p>
      <div className="field">
        <label htmlFor={searchId}>Search services</label>
        <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Gmail, Calendar, Slack" autoComplete="off" maxLength={80} />
      </div>

      {watch ? <WatchPanel watch={watch} onOpenAccounts={props.onOpenAccounts} onClose={() => setWatch(null)} /> : null}

      {results.error ? <Notice tone="error">{results.error}</Notice> : null}
      {results.data && !results.data.composioKey ? (
        <Notice>Add your Composio API key: in Teal Brick Portal open Connect's keys (the key page of your workspace). Connect never shows the key.</Notice>
      ) : null}
      {results.loading && !results.data ? <p className="muted">Loading services.</p> : null}
      {results.data?.catalogAvailable === false ? <Notice>The Tealbrick catalog of self-hosted apps is not available right now.</Notice> : null}
      {results.data && results.data.services.length === 0 && !results.loading ? <p className="muted">No service matches this search.</p> : null}

      <ul className="cards" aria-label="Services">
        {(results.data?.services ?? []).map((service) => (
          <li key={service.service} className="card">
            <ServiceCard
              service={service}
              open={picked === service.service}
              onOpen={() => setPicked(service.service)}
              onClose={() => setPicked(null)}
              onStarted={(started) => {
                setPicked(null);
                setWatch(started);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function WatchPanel(props: { watch: Watch; onOpenAccounts(): void; onClose(): void }) {
  const { watch } = props;
  return (
    <section className="panel" aria-label="Connection progress">
      {watch.phase === "waiting" ? (
        <Notice>
          Waiting for you to finish signing in for "{watch.label}". If no window opened,{" "}
          <a href={watch.redirectUrl} target="_blank" rel="noopener noreferrer">
            open the sign-in page
          </a>
          .
        </Notice>
      ) : null}
      {watch.phase === "connected" ? (
        <Notice>
          "{watch.label}" is connected. Next, set what each agent may do with it in{" "}
          <a
            href="./configure"
            onClick={(e) => {
              e.preventDefault();
              props.onOpenAccounts();
            }}
          >
            Accounts
          </a>
          .
        </Notice>
      ) : null}
      {watch.phase === "failed" ? <Notice tone="error">"{watch.label}" did not connect.{watch.detail ? ` ${watch.detail}` : ""}</Notice> : null}
      {watch.phase === "timeout" ? <Notice tone="error">No answer after 5 minutes for "{watch.label}". Check Accounts to see if it connected, or try again.</Notice> : null}
      {watch.phase !== "waiting" ? (
        <Button type="button" variant="secondary" onClick={props.onClose}>
          Dismiss
        </Button>
      ) : null}
    </section>
  );
}

function ServiceCard(props: { service: ServiceHit; open: boolean; onOpen(): void; onClose(): void; onStarted(watch: Watch): void }) {
  const { service } = props;
  return (
    <>
      <div className="card-head">
        <h3 className="card-title">{service.name}</h3>
        <ConnectState service={service} open={props.open} onOpen={props.onOpen} />
      </div>
      {service.description ? <p className="card-text">{service.description}</p> : null}
      {props.open ? <ConnectForm service={service} onCancel={props.onClose} onStarted={props.onStarted} /> : null}
    </>
  );
}

function ConnectState({ service, open, onOpen }: { service: ServiceHit; open: boolean; onOpen(): void }) {
  switch (service.connectMode) {
    case "needs_auth_config":
      return <span className="muted note">Needs an OAuth app in your Composio dashboard first.</span>;
    case "no_auth":
      return <span className="muted note">Needs no sign-in.</span>;
    case "not_supported":
      return <span className="muted note">Cannot be connected yet.</span>;
    default:
      return (
        <Button type="button" variant="primary" onClick={onOpen} disabled={open} aria-label={`Connect ${service.name}`}>
          Connect
        </Button>
      );
  }
}

const FIELD_LABEL: Record<string, string> = { token: "API token", username: "Username", password: "Password" };

/** Kind ("As me" / "As itself") and, for "As itself", the agent picker; shared by both connect forms. */
function useKindFields() {
  const ids = { kind: useId(), agent: useId() };
  const [kind, setKind] = useState<AccountKind>("as_me");
  const [agent, setAgent] = useState("");
  const agents = useLoad(agentsList, kind);
  const node = (
    <>
      <div className="field">
        <label htmlFor={ids.kind}>Use this account</label>
        <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
          <option value="as_me">As me</option>
          <option value="as_itself">As itself (one agent's own account)</option>
        </select>
      </div>
      {kind === "as_itself" ? (
        <div className="field">
          <label htmlFor={ids.agent}>Agent</label>
          <select id={ids.agent} value={agent} onChange={(e) => setAgent(e.target.value)} required>
            <option value="">Choose an agent</option>
            {(agents.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {agents.error ? <Notice tone="error">{agents.error}</Notice> : null}
        </div>
      ) : null}
    </>
  );
  return { kind, agent, node };
}

function FormButtons(props: { busy: boolean; submitLabel: string; onCancel(): void }) {
  return (
    <div className="row">
      <Button type="submit" variant="primary" disabled={props.busy}>
        {props.busy ? "Working" : props.submitLabel}
      </Button>
      <Button type="button" variant="secondary" onClick={props.onCancel} disabled={props.busy}>
        Cancel
      </Button>
    </div>
  );
}

function ConnectForm(props: { service: ServiceHit; onCancel(): void; onStarted(watch: Watch): void }) {
  return props.service.source === "catalog" ? <CatalogForm {...props} /> : <ComposioForm {...props} />;
}

/** Composio services: sign in through a popup, then wait for the account to become connected. */
function ComposioForm(props: { service: ServiceHit; onCancel(): void; onStarted(watch: Watch): void }) {
  const { service } = props;
  const labelId = useId();
  const [label, setLabel] = useState(service.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { kind, agent, node } = useKindFields();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!label.trim()) return setError("Give this account a label.");
    if (kind === "as_itself" && !agent) return setError("Pick the agent this account belongs to.");
    setBusy(true);
    try {
      const out = await accountConnect({ service: service.service, label: label.trim(), kind, ...(kind === "as_itself" ? { agent } : {}) });
      let target: URL;
      try {
        target = new URL(out.redirectUrl);
      } catch {
        throw new Error("The sign-in address is not valid.");
      }
      if (target.protocol !== "https:") throw new Error("The sign-in address is not secure.");
      window.open(target.href, "tb-connect-signin", "popup,width=520,height=720,noopener,noreferrer");
      props.onStarted({ accountId: out.account.id, label: out.account.label, redirectUrl: target.href, phase: "waiting", detail: "" });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} aria-label={`Connect ${service.name}`}>
      <div className="field">
        <label htmlFor={labelId}>Label</label>
        <input id={labelId} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required />
      </div>
      {node}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <FormButtons busy={busy} submitLabel="Sign in and connect" onCancel={props.onCancel} />
    </form>
  );
}

/** Catalog (self-hosted) services: address and API credentials; the account is connected at once, no popup. */
function CatalogForm(props: { service: ServiceHit; onCancel(): void; onStarted(watch: Watch): void }) {
  const { service } = props;
  const ids = { label: useId(), baseUrl: useId(), field: useId() };
  const fields = service.fields && service.fields.length > 0 ? service.fields : ["token"];
  const [label, setLabel] = useState(service.name);
  const [baseUrl, setBaseUrl] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { kind, agent, node } = useKindFields();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!label.trim()) return setError("Give this account a label.");
    if (!baseUrl.trim()) return setError("Enter the address of the app.");
    if (fields.some((f) => !credentials[f])) return setError("Fill in every credential field.");
    if (kind === "as_itself" && !agent) return setError("Pick the agent this account belongs to.");
    setBusy(true);
    try {
      const out = await catalogAccountConnect({
        service: service.service,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        credentials: Object.fromEntries(fields.map((f) => [f, credentials[f] ?? ""])),
        kind,
        ...(kind === "as_itself" ? { agent } : {}),
      });
      setCredentials({});
      props.onStarted({ accountId: out.account.id, label: out.account.label, redirectUrl: "", phase: out.account.status === "failed" ? "failed" : "connected", detail: out.account.detail });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} aria-label={`Connect ${service.name}`} autoComplete="off">
      <div className="field">
        <label htmlFor={ids.label}>Label</label>
        <input id={ids.label} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required />
      </div>
      <div className="field">
        <label htmlFor={ids.baseUrl}>Address of the app</label>
        <input
          id={ids.baseUrl}
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={service.baseUrlExample ?? "https://"}
          maxLength={300}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </div>
      {fields.map((field) => (
        <div className="field" key={field}>
          <label htmlFor={`${ids.field}-${field}`}>{FIELD_LABEL[field] ?? field}</label>
          <input
            id={`${ids.field}-${field}`}
            type="password"
            value={credentials[field] ?? ""}
            onChange={(e) => setCredentials((c) => ({ ...c, [field]: e.target.value }))}
            maxLength={4096}
            autoComplete="new-password"
            spellCheck={false}
            required
          />
        </div>
      ))}
      <p className="muted">The key stays in Connect. Connect never shows it again.</p>
      {node}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <FormButtons busy={busy} submitLabel="Connect" onCancel={props.onCancel} />
    </form>
  );
}
