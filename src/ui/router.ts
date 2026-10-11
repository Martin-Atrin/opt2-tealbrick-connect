import { useEffect, useState } from "react";

export type Route = "services" | "accounts" | "buzz";

const BASE = (import.meta.env.BASE_URL ?? "/").replace(/\/*$/u, "/");

/** `/` is Services (ui.launchPath), `/configure` is Accounts (ui.configurePath), `/configure#buzz` is Buzz. */
export const HREF: Record<Route, string> = { services: BASE, accounts: `${BASE}configure`, buzz: `${BASE}configure#buzz` };

function current(): Route {
  const path = location.pathname.slice(BASE.length - 1).replace(/\/+$/u, "") || "/";
  if (path !== "/configure") return "services";
  return location.hash === "#buzz" ? "buzz" : "accounts";
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const sync = () => setRoute(current());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const go = (next: Route) => {
    history.pushState(null, "", HREF[next]);
    setRoute(next);
    window.scrollTo(0, 0);
  };
  return [route, go];
}
