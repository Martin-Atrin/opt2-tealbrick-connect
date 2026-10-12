/**
 * Buzz relay HTTP client for agent channel work (harvest: v1 providers/buzz.ts:346-386, 467-502, 544-600, 932-975).
 * - `POST <relay>/query` (NIP-01 filters) and `POST <relay>/events`, each with a fresh NIP-98 header signed by the
 *   agent's own key. The relay enforces channel membership on the agent's pubkey (NIP-29 / NIP-AA).
 * - Channels: kind 39002 member lists naming the agent, then kind 39000 metadata.
 * - Messages: kind 9 with `h` = channel id; replies use NIP-10 `e` root/reply tags. Text from the relay is untrusted:
 *   events are signature-checked, control and bidi characters stripped, length capped.
 */
import { type FetchLike, requestJson, UpstreamError } from "../../util/http.ts";
import { NetPolicyError } from "../../util/net-policy.ts";
import type { BuzzIdentities } from "./identity.ts";
import { type NostrEvent, npubEncode, parsePubkey, verifyEvent } from "./nostr.ts";
import { BuzzRefusal, type RelayOutcome } from "./relays.ts";

export { BuzzRefusal, type RelayOutcome } from "./relays.ts";

export const KIND_CHAT = 9;
export const KIND_DM_OPEN = 41010;
export const KIND_REACTION = 7;
export const KIND_DELETION = 5;
export const KIND_EDIT = 40003;
export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_MEMBERS = 39002;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TEXT = 20_000;

export type BuzzChannel = {
  id: string;
  name: string;
  type: "channel" | "group" | "direct";
};
export type BuzzChannelOnRelays = BuzzChannel & { relays: string[] };
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


type Settled<T> = { relay: string; ok: true; value: T } | { relay: string; ok: false; error: unknown };
type Answer = { accepted?: boolean; message?: string };

const errorCode = (error: unknown): string =>
  error instanceof BuzzRefusal || error instanceof UpstreamError || error instanceof NetPolicyError
    ? error.code
    : error instanceof Error && /^[a-z_]+(?::|$)/u.test(error.message)
      ? (error.message.split(":")[0] ?? "buzz_relay_error")
      : "buzz_relay_error";

/** Per-relay failure as shown in op results (relay text is cleaned and capped; it never carries Connect secrets). */
export function failedOutcome(relay: string, error: unknown): RelayOutcome {
  return { relay, ok: false, error: errorCode(error), detail: cleanText(error instanceof Error ? error.message : String(error), 200) };
}

/**
 * No relay accepted: one relay → its own error (unchanged single-relay behaviour); several relays with the same refusal →
 * that refusal; otherwise `buzz_relays_failed` naming every relay and its error code.
 */
function noneAccepted(results: Settled<unknown>[], what: string): never {
  const failures = results.filter((r): r is Extract<Settled<unknown>, { ok: false }> => !r.ok);
  if (failures.length === 1) throw failures[0]?.error;
  const first = failures[0]?.error;
  const codes = failures.map((f) => errorCode(f.error));
  if (first instanceof BuzzRefusal && codes.every((c) => c === first.code) && failures.every((f) => f.error instanceof BuzzRefusal)) {
    throw new BuzzRefusal(first.code, `${first.message} (all ${failures.length} relays)`, first.httpStatus);
  }
  throw new BuzzRefusal("buzz_relays_failed", `No Buzz relay accepted ${what}. ${failures.map((f, i) => `${f.relay}: ${codes[i]}`).join("; ")}.`, 502);
}

function rejected(answer: Answer | null | undefined, what: string): BuzzRefusal | null {
  if (answer?.accepted !== false) return null;
  const reason = cleanText(String(answer.message ?? ""), 200);
  if (/not a (channel|group) member|not a member/iu.test(reason)) return relayRefusal(new UpstreamError("upstream_error", reason, 400)) as BuzzRefusal;
  return new BuzzRefusal("buzz_rejected", `The Buzz relay rejected ${what}: ${reason}`, 409);
}

export class BuzzRelay {
  readonly #identities: BuzzIdentities;
  readonly #fetch: FetchLike | undefined;

  constructor(identities: BuzzIdentities, fetchImpl?: FetchLike) {
    this.#identities = identities;
    this.#fetch = fetchImpl;
  }

  async #post<T>(agent: string, relay: string, path: "/query" | "/events", payload: unknown): Promise<T> {
    const url = `${await this.#identities.relayHttpBase(relay)}${path}`;
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

  /** Run one step on every relay in parallel; results keep the relay order. */
  async #each<T>(relays: readonly string[], step: (relay: string) => Promise<T>): Promise<Settled<T>[]> {
    return Promise.all(
      relays.map(async (relay): Promise<Settled<T>> => {
        try {
          return { relay, ok: true, value: await step(relay) };
        } catch (error) {
          return { relay, ok: false, error };
        }
      }),
    );
  }

  /** Publish one signed event to every relay; at least one must accept. */
  async #publishSigned(agent: string, relays: readonly string[], event: NostrEvent, what: string): Promise<RelayOutcome[]> {
    const results = await this.#each(relays, async (relay) => {
      const refusal = rejected(await this.#post<Answer>(agent, relay, "/events", event), what);
      if (refusal) throw refusal;
    });
    if (!results.some((r) => r.ok)) noneAccepted(results, what);
    return results.map((r) => (r.ok ? { relay: r.relay, ok: true } : failedOutcome(r.relay, r.error)));
  }

  async #publish(agent: string, input: { kind: number; tags: string[][]; content: string; relays?: readonly string[] }, what: string): Promise<{ id: string; relays: RelayOutcome[] }> {
    const relays = this.#identities.relaysFor(agent, input.relays);
    const event = await this.#identities.sign(agent, { kind: input.kind, tags: input.tags, content: input.content });
    return { id: event.id, relays: await this.#publishSigned(agent, relays, event, what) };
  }

  /** Query every relay of the agent; signature-checked events merged by id. At least one relay must answer. */
  async query(agent: string, filters: Record<string, unknown>[], options: { relays?: readonly string[] } = {}): Promise<{ events: NostrEvent[]; relays: RelayOutcome[] }> {
    const relays = this.#identities.relaysFor(agent, options.relays);
    const results = await this.#each(relays, async (relay) => {
      const answer = await this.#post<unknown>(agent, relay, "/query", filters);
      if (!Array.isArray(answer)) throw new Error("buzz_bad_response");
      return answer.filter(verifyEvent);
    });
    if (!results.some((r) => r.ok)) noneAccepted(results, "the query");
    const byId = new Map<string, NostrEvent>();
    for (const r of results) if (r.ok) for (const event of r.value) if (!byId.has(event.id)) byId.set(event.id, event);
    return { events: [...byId.values()], relays: results.map((r) => (r.ok ? { relay: r.relay, ok: true } : failedOutcome(r.relay, r.error))) };
  }

  /** Channels whose member list names the agent, on every relay; each channel lists the relays it was found on. */
  async channels(agent: string, options: { relays?: readonly string[] } = {}): Promise<{ channels: BuzzChannelOnRelays[]; relays: RelayOutcome[] }> {
    const identity = this.#identities.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    const relays = this.#identities.relaysFor(agent, options.relays);
    const results = await this.#each(relays, async (relay) => {
      const ask = async (filter: Record<string, unknown>) => {
        const answer = await this.#post<unknown>(agent, relay, "/query", [filter]);
        if (!Array.isArray(answer)) throw new Error("buzz_bad_response");
        return answer.filter(verifyEvent);
      };
      const members = await ask({ kinds: [KIND_GROUP_MEMBERS], "#p": [identity.pubkey], limit: 200 });
      // A relay is untrusted: keep only member lists that name the agent and metadata events of the asked kind.
      const mine = members.filter((e) => e.kind === KIND_GROUP_MEMBERS && e.tags.some((t) => t[0] === "p" && t[1] === identity.pubkey));
      const ids = [...new Set(mine.map((e) => tag(e, "d")).filter((id): id is string => typeof id === "string" && isChannelId(id)))];
      const out = new Map<string, BuzzChannel>();
      if (ids.length === 0) return out;
      for (const event of await ask({ kinds: [KIND_GROUP_METADATA], "#d": ids, limit: 200 })) {
        const id = tag(event, "d");
        if (event.kind !== KIND_GROUP_METADATA || !id || !ids.includes(id) || out.has(id) || hasFlag(event, "archived")) continue;
        const type = hasFlag(event, "hidden") ? "direct" : hasFlag(event, "private") ? "group" : "channel";
        out.set(id, { id, name: cleanText(tag(event, "name") ?? "", 80), type });
      }
      return out;
    });
    if (!results.some((r) => r.ok)) noneAccepted(results, "the channel list");
    const merged = new Map<string, BuzzChannelOnRelays>();
    for (const r of results) {
      if (!r.ok) continue;
      for (const channel of r.value.values()) {
        const seen = merged.get(channel.id);
        if (seen) seen.relays.push(r.relay);
        else merged.set(channel.id, { ...channel, relays: [r.relay] });
      }
    }
    return {
      channels: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
      relays: results.map((r) => (r.ok ? { relay: r.relay, ok: true } : failedOutcome(r.relay, r.error))),
    };
  }

  async read(agent: string, input: { channel: string; since?: number; limit?: number; relays?: readonly string[] }): Promise<{ messages: BuzzMessage[]; relays: RelayOutcome[] }> {
    const identity = this.#identities.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    const limit = Math.max(1, Math.min(input.limit ?? 30, 100));
    const filter: Record<string, unknown> = { kinds: [KIND_CHAT], "#h": [input.channel], limit };
    if (input.since !== undefined) filter.since = Math.max(0, Math.floor(input.since));
    const { events, relays } = await this.query(agent, [filter], input.relays ? { relays: input.relays } : {});
    const messages = events
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
    return { messages, relays };
  }

  async post(
    agent: string,
    input: { channel: string; content: string; replyTo?: { id: string; root?: string }; relays?: readonly string[] },
  ): Promise<{ id: string; relays: RelayOutcome[] }> {
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    const content = input.content.trim();
    if (!content || content.length > MAX_TEXT) throw new Error("buzz_content_invalid");
    const tags: string[][] = [["h", input.channel]];
    if (input.replyTo) {
      if (!/^[0-9a-f]{64}$/u.test(input.replyTo.id) || (input.replyTo.root && !/^[0-9a-f]{64}$/u.test(input.replyTo.root))) throw new Error("buzz_reply_invalid");
      tags.push(["e", input.replyTo.root ?? input.replyTo.id, "", "root"]);
      if (input.replyTo.root && input.replyTo.root !== input.replyTo.id) tags.push(["e", input.replyTo.id, "", "reply"]);
    }
    return this.#publish(agent, { kind: KIND_CHAT, tags, content, ...(input.relays ? { relays: input.relays } : {}) }, "the message");
  }

  /**
   * Open (or reuse) the direct-message channel with one person on every relay (Buzz kind 41010 with a `p` tag; each relay
   * answers `response:{"channel_id": …}`), then post kind 9 into it. Channel ids are per relay, so the message is
   * signed once per distinct channel id. The top-level id/channel are those of the first relay that accepted.
   */
  async directMessage(
    agent: string,
    input: { to: string; content: string; relays?: readonly string[] },
  ): Promise<{ id: string; channel: string; to: string; relays: RelayOutcome[]; sent: { id: string; channel: string }[] }> {
    const identity = this.#identities.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    const to = parsePubkey(input.to);
    if (!to) throw new BuzzRefusal("buzz_recipient_invalid", "Give the person's Buzz key as npub1… or 64 hex.", 400);
    if (to === identity.pubkey) throw new BuzzRefusal("buzz_recipient_invalid", "You cannot send a direct message to yourself.", 400);
    const content = input.content.trim();
    if (!content || content.length > MAX_TEXT) throw new Error("buzz_content_invalid");
    const relays = this.#identities.relaysFor(agent, input.relays);
    const open = await this.#identities.sign(agent, { kind: KIND_DM_OPEN, tags: [["p", to]], content: "" });
    const opened = await this.#each(relays, async (relay) => {
      const answer = await this.#post<Answer>(agent, relay, "/events", open);
      if (answer?.accepted === false) throw new BuzzRefusal("buzz_rejected", `The Buzz relay refused to open the conversation: ${cleanText(String(answer.message ?? ""), 200)}`, 409);
      const message = String(answer?.message ?? "");
      let channel: string | undefined;
      if (message.startsWith("response:")) {
        try {
          const id = (JSON.parse(message.slice("response:".length)) as { channel_id?: unknown }).channel_id;
          channel = typeof id === "string" && isChannelId(id) ? id : undefined;
        } catch {
          channel = undefined;
        }
      }
      if (!channel) throw new BuzzRefusal("buzz_bad_response", "The Buzz relay did not return the conversation id.", 502);
      return channel;
    });
    if (!opened.some((r) => r.ok)) noneAccepted(opened, "the conversation");
    const byChannel = new Map<string, string[]>();
    for (const r of opened) if (r.ok) byChannel.set(r.value, [...(byChannel.get(r.value) ?? []), r.relay]);
    const posted = new Map<string, Settled<{ id: string; channel: string }>>();
    for (const [channel, group] of byChannel) {
      const event = await this.#identities.sign(agent, { kind: KIND_CHAT, tags: [["h", channel]], content });
      const results = await this.#each(group, async (relay) => {
        const refusal = rejected(await this.#post<Answer>(agent, relay, "/events", event), "the message");
        if (refusal) throw refusal;
        return { id: event.id, channel };
      });
      for (const r of results) posted.set(r.relay, r);
    }
    const all = relays.map((relay) => {
      const open = opened.find((o) => o.relay === relay);
      return open && !open.ok ? open : (posted.get(relay) as Settled<{ id: string; channel: string }>);
    });
    const first = all.find((r): r is Extract<Settled<{ id: string; channel: string }>, { ok: true }> => r.ok);
    if (!first) noneAccepted(all, "the message");
    const sent = [...new Map(all.flatMap((r) => (r.ok ? [[r.value.id, r.value] as const] : []))).values()];
    return {
      id: first.value.id,
      channel: first.value.channel,
      to: npubEncode(to),
      relays: all.map((r) => (r.ok ? { relay: r.relay, ok: true, id: r.value.id, channel: r.value.channel } : failedOutcome(r.relay, r.error))),
      sent,
    };
  }

  /** Reaction (kind 7) on a message in a channel: one emoji or short symbol (v1 rule). */
  async react(agent: string, input: { channel: string; messageId: string; emoji: string; relays?: readonly string[] }): Promise<{ id: string; relays: RelayOutcome[] }> {
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    if (!/^[0-9a-f]{64}$/u.test(input.messageId)) throw new BuzzRefusal("buzz_message_invalid", "messageId must be a 64-hex event id.", 400);
    const points = Array.from(input.emoji);
    if (points.length < 1 || points.length > 16 || /[\s:]/u.test(input.emoji) || /[\p{Cc}\p{Cf}]/u.test(input.emoji)) {
      throw new BuzzRefusal("buzz_reaction_invalid", "A reaction is one emoji or a short symbol such as +.", 400);
    }
    return this.#publish(agent, { kind: KIND_REACTION, tags: [["e", input.messageId], ["h", input.channel]], content: input.emoji, ...(input.relays ? { relays: input.relays } : {}) }, "the action");
  }

  /** Edit (kind 40003) of an own message; the caller checks ownership. Edits never mention anyone. */
  async edit(agent: string, input: { channel: string; messageId: string; content: string; relays?: readonly string[] }): Promise<{ id: string; relays: RelayOutcome[] }> {
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    const content = input.content.trim();
    if (!content || content.length > MAX_TEXT) throw new Error("buzz_content_invalid");
    return this.#publish(agent, { kind: KIND_EDIT, tags: [["h", input.channel], ["e", input.messageId]], content, ...(input.relays ? { relays: input.relays } : {}) }, "the action");
  }

  /** Deletion (kind 5, single target) of an own message; the caller checks ownership. */
  async remove(agent: string, input: { channel: string; messageId: string; relays?: readonly string[] }): Promise<{ id: string; relays: RelayOutcome[] }> {
    if (!isChannelId(input.channel)) throw new Error("buzz_channel_invalid");
    return this.#publish(agent, { kind: KIND_DELETION, tags: [["h", input.channel], ["e", input.messageId]], content: "", ...(input.relays ? { relays: input.relays } : {}) }, "the action");
  }

  /** Publish the agent's kind 0 profile to every relay it uses (`POST https://<relay>/events`, NIP-98). */
  async publishProfile(agent: string, about = "Teal Brick agent"): Promise<{ identity: ReturnType<BuzzIdentities["markProfilePublished"]>; relays: RelayOutcome[] }> {
    const identity = this.#identities.get(agent);
    if (!identity) throw new Error("buzz_identity_missing");
    const content = JSON.stringify({ name: identity.displayName, display_name: identity.displayName, about: about.slice(0, 280) });
    const { relays } = await this.#publish(agent, { kind: 0, tags: [], content }, "the profile");
    return { identity: this.#identities.markProfilePublished(agent), relays };
  }
}
