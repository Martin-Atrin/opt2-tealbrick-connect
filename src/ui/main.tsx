import { TbProvider } from "@opt2-tealbrick/miniapp-sdk/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./Layout.tsx";
import { Accounts } from "./pages/Accounts.tsx";
import { Buzz } from "./pages/Buzz.tsx";
import { Services } from "./pages/Services.tsx";
import { useRoute } from "./router.ts";
import "@opt2-tealbrick/ui/tokens.css";
import "@opt2-tealbrick/ui/components.css";
import "./app.css";

function App() {
  const [route, go] = useRoute();
  return (
    <Layout route={route} onNavigate={go}>
      {route === "services" ? <Services onOpenAccounts={() => go("accounts")} /> : route === "accounts" ? <Accounts /> : <Buzz />}
    </Layout>
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
