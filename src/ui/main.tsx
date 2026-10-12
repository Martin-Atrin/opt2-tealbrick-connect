// UI entry: served by the SDK from dist/ui under /a/connect/ behind the person session (SDK-API §3.2, §14).
import { TbProvider, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, BrandMark, STANDARD_PAGES } from "@opt2-tealbrick/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Notice } from "./components.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Buzz } from "./pages/Buzz.tsx";
import { Chat } from "./pages/Chat.tsx";
import { Senders } from "./pages/Senders.tsx";
import { Services } from "./pages/Services.tsx";
import { Agents, Backups, Holds, Keys, Receipts } from "./pages/Standard.tsx";
import { ROUTES, type Route, useRoute } from "./router.ts";

const PAGES = [{ id: "services", label: "Services" }, { id: "accounts", label: "Accounts" }, { id: "buzz", label: "Buzz" }, { id: "chat", label: "Chat bots" }, { id: "senders", label: "Senders" }, ...STANDARD_PAGES];

function Page({ route, go }: { route: Route; go(route: Route): void }) {
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
      return <Holds />;
    case "receipts":
      return <Receipts />;
    case "agents":
      return <Agents />;
    case "keys":
      return <Keys />;
    case "backups":
      return <Backups />;
  }
}

function App() {
  const [route, go] = useRoute();
  const session = useSession();
  return (
    <AppShell
      title="Connect"
      icon={<BrandMark size={22} />}
      pages={PAGES}
      current={route}
      onNavigate={(id) => {
        if ((ROUTES as readonly string[]).includes(id)) go(id as Route);
      }}
      banner={session.status === "signed_out" ? <Notice tone="error">Your session ended. Open Connect again from Teal Brick Portal.</Notice> : undefined}
    >
      <Page route={route} go={go} />
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
