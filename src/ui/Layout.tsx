/**
 * TEMPORARY shell. Replace this whole file with `<AppShell>` from `@opt2-tealbrick/ui` (re-exported by
 * `@opt2-tealbrick/miniapp-sdk/client`, SDK-API §14) when that package is released. The shell then owns the
 * header, the navigation, the standard pages (Holds, Receipts, Agents & scopes, Keys, Backups) and the session
 * states; the Connect pages below stay as its children.
 */
import type { ReactNode } from "react";

import { Notice } from "./components.tsx";
import { HREF, type Route } from "./router.ts";
import { useSession } from "./sdk.ts";

const TABS: { route: Route; label: string }[] = [
  { route: "services", label: "Services" },
  { route: "accounts", label: "Accounts" },
  { route: "buzz", label: "Buzz" },
];

export function Layout(props: { route: Route; onNavigate(route: Route): void; children: ReactNode }) {
  const session = useSession();
  return (
    <div className="shell">
      <header className="shell-head">
        <h1 className="brand">Connect</h1>
        <nav aria-label="Connect sections" className="tabs">
          {TABS.map((tab) => (
            <a
              key={tab.route}
              href={HREF[tab.route]}
              className="tab"
              aria-current={props.route === tab.route ? "page" : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                event.preventDefault();
                props.onNavigate(tab.route);
              }}
            >
              {tab.label}
            </a>
          ))}
        </nav>
      </header>
      <main className="shell-main">
        {session.status === "signed_out" ? <Notice tone="error">Your session ended. Open Connect again from Teal Brick Portal.</Notice> : null}
        {props.children}
      </main>
    </div>
  );
}
