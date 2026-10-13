/**
 * Buzz relay list (DECISION-LOG C73): a workspace has an ordered list of relays (company relay first); every agent uses
 * all of them unless the owner limits it to a subset (stored in Connect's DB, see identity.ts).
 *
 * - Setting `buzz_relays` (env CONNECT_BUZZ_RELAYS, owner input in Portal): wss addresses separated by new lines, commas
 *   or spaces. Normalised (`wss://host[:port]`), deduplicated, at most MAX_RELAYS.
 * - C133: the old single setting `buzz_relay_url` is gone (no compat for earlier opt2 dev formats). Only the list is read.
 *   When the old env is still present the list reports a clear problem (and Buzz ops refuse with
 *   `buzz_relay_setting_removed` while the list is empty) instead of silently running without a relay.
 * - Owner input is untrusted: only wss://, no path/query/userinfo, and no loopback/private/link-local/local-name host
 *   (sync check here; the DNS answers are checked again on every use by net-policy + the pinned fetch).
 *   `ws://` and private hosts only for exact allowlisted origins (tests / in-process test relays). There is no
 *   bridge own-infra allow-list that reaches apps today (noted for Specs).
 */
import { isIP } from "node:net";

import { isForbiddenAddress, isForbiddenHostname } from "../../util/net-policy.ts";

export const MAX_RELAYS = 8;

/** `wss://host[:port]` only (no path, query, userinfo); `ws://` and private hosts only for an exact allowlisted origin. */
export function normalizeRelayUrl(value: string, allowOrigins: readonly string[] = []): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("relay_url_invalid");
  }
  const allowed = allowOrigins.includes(url.origin);
  const testOrigin = url.protocol === "ws:" && allowed;
  if ((url.protocol !== "wss:" && !testOrigin) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("relay_url_invalid");
  }
  if (!allowed) {
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    if (isIP(host) ? isForbiddenAddress(host) : isForbiddenHostname(host)) throw new Error("relay_host_not_allowed");
  }
  return `${url.protocol}//${url.host}`;
}

export interface RelayList {
  /** Normalised, deduplicated, ordered, at most MAX_RELAYS. */
  relays: string[];
  /** Owner-facing notes on entries that were skipped (invalid, private host, over the limit). */
  problems: string[];
}

const show = (entry: string) => (entry.length > 80 ? `${entry.slice(0, 77)}...` : entry).replace(/[\p{Cc}\p{Cf}]/gu, "");

/** Owner-facing text when the removed single-relay setting is still set (C133). */
export const OLD_RELAY_SETTING_PROBLEM =
  "The old setting \"Buzz relay address\" (buzz_relay_url) is no longer read. Put the address in Buzz relays in Connect's settings in Portal.";

/** Workspace relays: the `buzz_relays` list only. `oldSettingPresent` = the removed `buzz_relay_url` env is still set. */
export function workspaceRelayList(input: { list?: string | null; oldSettingPresent?: boolean; allowOrigins?: readonly string[] }): RelayList {
  const entries = (input.list ?? "").split(/[\s,;]+/u).map((e) => e.trim()).filter(Boolean);
  const relays: string[] = [];
  const problems: string[] = input.oldSettingPresent ? [OLD_RELAY_SETTING_PROBLEM] : [];
  for (const entry of entries) {
    let relay: string;
    try {
      relay = normalizeRelayUrl(entry, input.allowOrigins ?? []);
    } catch (error) {
      problems.push(
        (error as Error).message === "relay_host_not_allowed"
          ? `Skipped ${show(entry)}: private, loopback and local addresses are not allowed.`
          : `Skipped ${show(entry)}: use a wss:// address without a path, for example wss://relay.example.com.`,
      );
      continue;
    }
    if (relays.includes(relay)) continue;
    if (relays.length >= MAX_RELAYS) {
      problems.push(`Skipped ${show(relay)}: at most ${MAX_RELAYS} relays.`);
      continue;
    }
    relays.push(relay);
  }
  return { relays, problems };
}

/** One relay's result inside an op result (C73: one relay down must not fail the op; say which failed). */
export type RelayOutcome =
  | { relay: string; ok: true; id?: string; channel?: string }
  | { relay: string; ok: false; error: string; detail: string };

/** A clear refusal for agent-facing Buzz errors (mapped to the SDK error envelope by the app). */
export class BuzzRefusal extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(message);
    this.name = "BuzzRefusal";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
