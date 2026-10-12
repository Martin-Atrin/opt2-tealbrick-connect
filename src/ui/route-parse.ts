/**
 * Where the browser is, as a Connect page. Pure (no React), so a unit test can pin every address an owner can arrive at.
 * `/` is Services (ui.launchPath), `/configure` is Accounts (ui.configurePath), `/configure#<id>` is another page, and
 * `/holds/<id>` (C105b: the link an app puts in `ctx.ownerLink("/holds/<id>")`) is the Holds page focused on that hold.
 */
export const ROUTES = ["services", "accounts", "buzz", "chat", "senders", "holds", "receipts", "agents", "keys", "backups"] as const;
export type Route = (typeof ROUTES)[number];

/** App base path (manifest ui paths live under `/a/<product>/`, see index.html `<base>`). */
export const BASE = "/a/connect/";

export type Where = { route: Route; /** the hold an owner link points at (Holds page) */ holdId?: string };

const HOLD_ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function parseWhere(pathname: string, hash: string): Where {
  const path = (pathname.startsWith(BASE.slice(0, -1)) ? pathname.slice(BASE.length - 1) : pathname).replace(/\/+$/u, "") || "/";
  const hold = /^\/holds(?:\/([^/]+))?$/u.exec(path);
  if (hold) {
    let id: string | undefined;
    try {
      id = hold[1] === undefined ? undefined : decodeURIComponent(hold[1]);
    } catch {
      id = undefined;
    }
    return id !== undefined && HOLD_ID.test(id) ? { route: "holds", holdId: id } : { route: "holds" };
  }
  if (path !== "/configure") return { route: "services" };
  const id = hash.replace(/^#/u, "");
  return { route: (ROUTES as readonly string[]).includes(id) ? (id as Route) : "accounts" };
}

/** `/` is Services, `/configure` is Accounts; other pages are `/configure#<id>`. */
export function hrefOf(route: Route): string {
  if (route === "services") return BASE;
  return route === "accounts" ? `${BASE}configure` : `${BASE}configure#${route}`;
}
