/**
 * Connect page frame built from @opt2-tealbrick/ui (BrandMark, Tabs, Notice). @opt2-tealbrick/ui 0.1.0 ships no
 * `<AppShell>` yet (SDK-API §14); when it does, this file is replaced by it and the pages stay its children.
 */
import { BrandMark, Tabs } from "@opt2-tealbrick/ui";
import type { ReactNode } from "react";

import { Notice } from "./components.tsx";
import type { Route } from "./router.ts";
import { useSession } from "./sdk.ts";

const TABS: { value: Route; label: string }[] = [
  { value: "services", label: "Services" },
  { value: "accounts", label: "Accounts" },
  { value: "buzz", label: "Buzz" },
];

export function Layout(props: { route: Route; onNavigate(route: Route): void; children: ReactNode }) {
  const session = useSession();
  return (
    <div className="shell">
      <header className="shell-head">
        <h1 className="brand">
          <BrandMark size={22} /> Connect
        </h1>
        <Tabs label="Connect sections" tabs={TABS} value={props.route} onChange={props.onNavigate} />
      </header>
      <main className="shell-main">
        {session.status === "signed_out" ? <Notice tone="error">Your session ended. Open Connect again from Teal Brick Portal.</Notice> : null}
        {props.children}
      </main>
    </div>
  );
}
