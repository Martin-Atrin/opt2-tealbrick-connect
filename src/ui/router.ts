import { useEffect, useState } from "react";

/** Connect pages first, then the SDK standard pages (ui STANDARD_PAGES ids). */
export const ROUTES = ["services", "accounts", "buzz", "chat", "senders", "holds", "receipts", "agents", "keys", "backups"] as const;
export type Route = (typeof ROUTES)[number];

/** App base path (manifest ui paths live under `/a/<product>/`, see index.html `<base>`). */
const BASE = "/a/connect/";

/** `/` is Services (ui.launchPath), `/configure` is Accounts (ui.configurePath); other pages are `/configure#<id>`. */
export function hrefOf(route: Route): string {
  if (route === "services") return BASE;
  return route === "accounts" ? `${BASE}configure` : `${BASE}configure#${route}`;
}

function current(): Route {
  const path = location.pathname.slice(BASE.length - 1).replace(/\/+$/u, "") || "/";
  if (path !== "/configure") return "services";
  const hash = location.hash.slice(1);
  return (ROUTES as readonly string[]).includes(hash) ? (hash as Route) : "accounts";
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const sync = () => setRoute(current());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const go = (next: Route) => {
    history.pushState(null, "", hrefOf(next));
    setRoute(next);
    window.scrollTo(0, 0);
  };
  return [route, go];
}
