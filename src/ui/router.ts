import { useEffect, useState } from "react";

import { hrefOf, parseWhere, ROUTES, type Route, type Where } from "./route-parse.ts";

export { hrefOf, ROUTES, type Route };

const here = (): Where => parseWhere(location.pathname, location.hash);

/** [page, go, where]: `where.holdId` is set when the address is `/holds/<id>` (an app's owner link). */
export function useRoute(): [Route, (route: Route) => void, Where] {
  const [where, setWhere] = useState<Where>(here);
  useEffect(() => {
    const sync = () => setWhere(here());
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);
  const go = (next: Route) => {
    history.pushState(null, "", hrefOf(next));
    setWhere({ route: next });
    window.scrollTo(0, 0);
  };
  return [where.route, go, where];
}
