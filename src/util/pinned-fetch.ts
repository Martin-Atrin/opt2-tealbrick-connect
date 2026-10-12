/**
 * Outbound fetch whose sockets connect only to addresses the net policy accepts (SEC-09: no DNS rebinding between the
 * check and the connect). The undici connector resolves the host itself, refuses the connection when ANY answer is
 * forbidden (loopback, private, link-local/metadata, ULA, CGNAT, multicast, …), and connects to the checked address.
 * IP-literal hosts are checked the same way. Exact allowlisted hosts (tests, test relay) skip the address check.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

import type { FetchLike } from "./http.ts";
import { isForbiddenAddress, NetPolicyError } from "./net-policy.ts";

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A `net.connect` lookup that validates every resolved address and returns only checked ones. */
export function checkedLookup(allowHosts: ReadonlySet<string> = new Set()) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback): void => {
    const all = typeof options === "object" && options.all === true;
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err, all ? [] : "");
      const list = addresses as LookupAddress[];
      if (!allowHosts.has(hostname.toLowerCase()) && (list.length === 0 || list.some((a) => isForbiddenAddress(a.address)))) {
        const e = new NetPolicyError("address_not_allowed") as NodeJS.ErrnoException & NetPolicyError;
        e.code = "endpoint_not_allowed";
        return callback(e, all ? [] : "");
      }
      if (all) return callback(null, list);
      const first = list[0] as LookupAddress;
      return callback(null, first.address, first.family);
    });
  };
}

/** A fetch bound to a pinned-connect dispatcher. IP-literal targets are checked before any socket opens. */
export function pinnedFetch(allowHosts: readonly string[] = []): FetchLike {
  const hosts = new Set(allowHosts.map((h) => h.toLowerCase()));
  const dispatcher = new Agent({ connect: { lookup: checkedLookup(hosts) as never } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(host) && !hosts.has(host) && isForbiddenAddress(host)) throw new NetPolicyError("address_not_allowed");
    return undiciFetch(url, { ...(init as object), dispatcher } as never);
  }) as unknown as FetchLike;
}

/** The default outbound fetch for owner-entered and third-party endpoints. */
export const safeFetch: FetchLike = pinnedFetch();
