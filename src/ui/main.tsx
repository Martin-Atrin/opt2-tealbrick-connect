// UI entry: served by the SDK from dist/ui under /a/connect/ behind the person session (SDK-API §3.2, §14).
import { TbProvider, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, STANDARD_PAGES, Swatch, Tag } from "@opt2-tealbrick/ui";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { Notice } from "./components.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Buzz } from "./pages/Buzz.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Keys } from "./pages/Keys.tsx";
import { Senders } from "./pages/Senders.tsx";
import { Services } from "./pages/Services.tsx";
import { hrefOf, ROUTES, type Route, useRoute } from "./router.ts";
import { AgentsPage, BackupsPage, HoldsPage, portalHref, ReceiptsPage, useHoldList } from "./standard.tsx";

const NAME = "Connect";
const COLOUR = appColour("connect");
/** Where scripts/build-ui.ts puts the kit's still for this app (`stills/`, next to this module). */
const STILLS = new URL("./stills/", import.meta.url).href;

const PAGES = [{ id: "services", label: "Services" }, { id: "accounts", label: "Accounts" }, { id: "buzz", label: "Buzz" }, { id: "chat", label: "Chat bots" }, { id: "senders", label: "Senders" }, ...STANDARD_PAGES];

function Page({ route, go, holdId, holds }: { route: Route; go(route: Route): void; holdId?: string | undefined; holds: ReturnType<typeof useHoldList> }) {
  switch (route) {
    case "services":
      return <Services onOpenAccounts={() => go("accounts")} />;
    case "accounts":
      return <Accounts />;
    case "buzz":
      return <Buzz />;
    case "chat":
      return <Chat />;
    case "senders":
      return <Senders />;
    case "holds":
      return <HoldsPage list={holds} only={holdId ?? null} empty="No calls wait for your approval." />;
    case "receipts":
      return <ReceiptsPage empty="No receipts yet." lede="What your agents did through Connect. Inputs are kept only as digests." />;
    case "agents":
      return (
        <AgentsPage
          empty="No agents are connected to Connect yet. Draw a line from an agent to Connect on the Portal canvas."
          render={(agents) => (
            // The mockup row: swatch, name and one state tag (Active / Paused).
            <div className="ruled">
              {agents.map((a) => (
                <div className="item" key={a.id}>
                  <Swatch />
                  <h3>{a.name}</h3>
                  <div className="side">{a.status === "paused" ? <Tag status="needs-you">Paused</Tag> : <Tag>Active</Tag>}</div>
                </div>
              ))}
            </div>
          )}
        />
      );
    case "keys":
      return <Keys />;
    case "backups":
      return (
        <BackupsPage
          text="Connect backs up its data every night to its own volume. Export gives you a readable copy (no secret values)."
        />
      );
  }
}

function App() {
  const [route, go, where] = useRoute();
  const { principal, status, signOut } = useSession();
  const holds = useHoldList();
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  const pages = PAGES.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p));
  const signedIn = status === "signed_in" && principal;
  return (
    <AppShell
      title={NAME}
      {...(COLOUR ? { colour: COLOUR } : {})}
      art={appArt("connect", STILLS)}
      portalHref={portal}
      pages={pages}
      current={route}
      onNavigate={(id) => {
        if ((ROUTES as readonly string[]).includes(id)) go(id as Route);
      }}
      pageHref={(id) => ((ROUTES as readonly string[]).includes(id) ? hrefOf(id as Route) : "./")}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="error">Your session ended. Open Connect again from Tealbrick Portal.</Notice>
        ) : notice ? (
          <Notice tone="error">{notice}</Notice>
        ) : null
      }
    >
      {signedIn ? <Page route={route} go={go} holdId={where.holdId} holds={holds} /> : null}
    </AppShell>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("root element missing");
createRoot(rootElement).render(
  <StrictMode>
    <TbProvider product="connect">
      <App />
    </TbProvider>
  </StrictMode>,
);
