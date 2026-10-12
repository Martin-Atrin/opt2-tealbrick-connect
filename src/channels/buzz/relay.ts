/**
 * Buzz relay HTTP client for agent channel work (harvest: v1 providers/buzz.ts:346-386, 467-502, 544-600, 932-975).
 * - `POST <relay>/query` (NIP-01 filters) and `POST <relay>/events`, each with a fresh NIP-98 header signed by the
 *   agent's own key. The relay enforces channel membership on the agent's pubkey (NIP-29 / NIP-AA).
 * - Channels: kind 39002 member lists naming the agent, then kind 39000 metadata.
 * - Messages: kind 9 with `h` = channel id; replies use NIP-10 `e` root/reply tags. Text from the relay is untrusted:
 *   events are signature-checked, control and bidi characters stripped, length capped.
 */
import { type FetchLike, requestJson, UpstreamError } from "../../util/http.ts";
import type { BuzzIdentities } from "./identity.ts";
import { type NostrEvent, npubEncode, verifyEvent } from "./nostr.ts";

export const KIND_CHAT = 9;
export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_MEMBERS = 39002;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TEXT = 20_000;

export type BuzzChannel = {
  id: string;
  name: string;
  type: "channel" | "group" | "direct";
};
export type BuzzMessage = {
  id: string;
  channel: string;
  author: string;
  fromSelf: boolean;
  content: string;
  createdAt: number;
  threadId: string | null;
};

const tag = (event: NostrEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];
const hasFlag = (event: NostrEvent, name: string) => event.tags.some((t) => t[0] === name && t.length === 1);

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

/** Relay refusals Connect turns into named codes (NIP-01 machine-readable prefixes, Buzz relay wording). */
export function relayRefusal(error: unknown): BuzzRefusal | null {
  if (!(error instanceof UpstreamError) || error.status === null || error.status >= 500) return null;
  if (/not a (channel|group) member|not a member/iu.test(error.message)) {
    return new BuzzRefusal("buzz_not_member", "Your Buzz identity is not a member of this channel. Ask the owner to add your npub to the channel in Buzz.", 403);
  }
  if (/restricted:/iu.test(error.message)) return new BuzzRefusal("buzz_restricted", "The Buzz relay refused this action for your identity.", 403);
  return null;
}

export function cleanText(text: string, max = MAX_TEXT): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : "")).slice(0, max);
}

export function isChannelId(value: string): boolean {
  return UUID.test(value);
}

export class BuzzRelay {
  readonly #identities: BuzzIdentities;
  readonly #fetch: FetchLike | undefined;

  constructor(identities: BuzzIdentities, fetchImpl?: FetchLike) {
    this.#identities = identities;
    this.#fetch = fetchImpl;
  }

  async #post<T>(agent: string, path: "/query" | "/events", payload: unknown): Promise<T> {
    const url = `${await this.#identities.relayHttpBase()}${path}`;
    const body = JSON.stringify(payload);
    try {
      return await requestJson<T>({
        method: "POST",
        url,
        body: payload,
        headers: { authorization: await this.#identities.authHeader(agent, { url, method: "POST", body }) },
        timeoutMs: 15_000,
        retries: path === "/query" ? 2 : 0,
        ...(this.#fetch ? { fetchImpl: this.#fetch } : {}),
      });
    } catch (error) {
      throw relayRefusal(error) ?? error;
    }
  }

  async query(agent: string, filters: Record<string, unknown>[]): Promise<NostrEvent[]> {
    const answer = await this.#post<unknown>(agent, "/query", filters);
    if (!Array.isArray(answer)) throw new Error("buzz_bad_response");
    return answer.filter(verifyEvent);
  }

  async channels(agent: string): Promise<BuzzChannel[]> {
    const identity = this.#identities.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    const members = await this.query(agent, [{ kinds: [KIND_GROUP_MEMBERS], "#p": [identity.pubkey], limit: 200 }]);
    const ids = [...new Set(members.map((e) => tag(e, "d")).filter((id): id is string => typeof id === "string" && isChannelId(id)))];
    if (ids.length === 0) return [];
    const metadata = await this.query(agent, [{ kinds: [KIND_GROUP_METADATA], "#d": ids, limit: 200 }]);
    const out = new Map<string, BuzzChannel>();
    for (const event of metadata) {
      const id = tag(event, "d");
      if (!id || !ids.includes(id) || out.has(id) || hasFlag(event, "archived")) continue;
      const type = hasFlag(event, "hidden") ? "direct" : hasFlag(event, "private") ? "group" : "channel";
      out.set(id, { id, name: cleanText(tag(event, "name") ?? "", 80), type });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(agent: string, input: { channel: string; since?: number; limit?: number }): Promise<BuzzMessage[]> {
    const identity = this.#identities.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
    const filter: Record<string, unknown> = { kinds: [KIND_CHAT], "#h": [input.channel], limit };
    if (input.since !== undefined) filter.since = Math.max(0, Math.floor(input.since));
    const events = await this.query(agent, [filter]);
    return events
      .filter((e) => e.kind === KIND_CHAT && tag(e, "h") === input.channel)
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .slice(-limit)
      .map((e) => ({
        id: e.id,
        channel: input.channel,
        author: npubEncode(e.pubkey),
        fromSelf: e.pubkey === identity.pubkey,
        content: cleanText(e.content),
        createdAt: e.created_at,
        threadId: e.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ?? null,
      }));
  }

  async post(agent: string, input: { channel: string; content: string; replyTo?: { id: string; root?: string } }): Promise<{ id: string }> {
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    const content = input.content.trim();
    if (!content || content.length > MAX_TEXT) throw new Error("buzz_content_invalid");
    const tags: string[][] = [["h", input.channel]];
    if (input.replyTo) {
      if (!/^[0-9a-f]{64}$/u.test(input.replyTo.id) || (input.replyTo.root && !/^[0-9a-f]{64}$/u.test(input.replyTo.root))) throw new Error("buzz_reply_invalid");
      tags.push(["e", input.replyTo.root ?? input.replyTo.id, "", "root"]);
      if (input.replyTo.root && input.replyTo.root !== input.replyTo.id) tags.push(["e", input.replyTo.id, "", "reply"]);
    }
    const event = await this.#identities.sign(agent, { kind: KIND_CHAT, tags, content });
    const answer = await this.#post<{ accepted?: boolean; message?: string }>(agent, "/events", event);
    if (answer?.accepted === false) {
      const reason = cleanText(String(answer.message ?? ""), 200);
      if (/not a (channel|group) member|not a member/iu.test(reason)) throw relayRefusal(new UpstreamError("upstream_error", reason, 400)) as BuzzRefusal;
      throw new BuzzRefusal("buzz_rejected", `The Buzz relay rejected the message: ${reason}`, 409);
    }
    return { id: event.id };
  }
}
