/**
 * The ONE channel provider interface (C58; harvest HARVEST-CHANNELS F1/F3–F7). Slack, Teams, Telegram and Discord
 * implement it; Connect's channel service owns accounts, the inbox, the sent-message ledger, first-contact records
 * and the long-running inbound workers. Providers are pure adapters: no database, no secrets store, no logging of
 * credentials. Every network call goes through `net.fetch` (pinned outbound in production, recorded fixtures in tests).
 *
 * Rules every provider follows:
 * - Never return, log or embed a credential in an error message (`scrub` the text with the credential values).
 * - Validate input before any request; refuse with `ChannelError` (stable `code`, owner-readable `message`).
 * - Inbound text is untrusted: strip control/bidi characters and cap length (`cleanInboundText`).
 * - Ignore the bot's own messages and other bots' messages on inbound.
 */
export const CHANNEL_SERVICES = ["slack", "teams", "telegram", "discord"] as const;
export type ChannelService = (typeof CHANNEL_SERVICES)[number];

/** Decrypted credential fields of one channel account (from ctx.secrets; never persisted elsewhere). */
export type ChannelCredentials = Record<string, string>;

export interface ChannelNet {
  fetch: typeof fetch;
  /** Opens an outbound WebSocket (Discord gateway, Slack Socket Mode). Production: global WebSocket. */
  webSocket: (url: string) => WebSocket;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class ChannelError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Who the bot is, from the provider's "who am I" call; stored as account metadata (no secrets). */
export interface BotIdentity {
  botId: string;
  botName: string;
  /** Slack team id / Teams tenant id / Discord application id, when the provider has one. */
  workspace?: string;
}

export interface Conversation {
  id: string;
  name: string;
  type: "channel" | "group" | "direct";
}

/** One inbound message, normalised. `messageId` is unique within (account, conversation). */
export interface InboundMessage {
  conversation: string;
  conversationName?: string;
  conversationType: "channel" | "group" | "direct";
  messageId: string;
  threadId: string | null;
  senderId: string;
  senderName: string;
  text: string;
  /** epoch ms from the provider when it has one, else receive time */
  sentAt: number;
  /**
   * F15: provider user ids this message mentions (the bot included when it was addressed), at most 50, de-duplicated.
   * Read as `<service>:<id>` handles (SDK-API §18) in channel_inbox.
   */
  mentions?: string[];
}

/** De-duplicated, bounded mention id list (F15). */
export function mentionList(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => id.length > 0 && id.length <= 200))].slice(0, 50);
}

export type InboundSink = (message: InboundMessage) => void;

export interface SendInput {
  conversation: string;
  text: string;
  /** reply in this thread (Slack thread_ts, Teams reply-to activity id, Telegram/Discord message id) */
  threadId?: string | null;
}

export interface ChannelProvider {
  service: ChannelService;
  /** Credential field names the owner enters (password inputs). */
  credentialFields: readonly string[];
  /** Optional non-secret settings per account (e.g. Discord `message_content` intent), with defaults. */
  settingFields?: readonly { key: string; label: string; type: "boolean" | "string"; default: boolean | string }[];
  maxTextLength: number;
  /** Check the credentials and return the bot identity (Slack auth.test, Telegram getMe, Discord /users/@me, Teams token + app id). */
  verify(creds: ChannelCredentials, net: ChannelNet): Promise<BotIdentity>;
  /** Conversations the bot can post to (bounded list, ≤ 200). */
  conversations(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity): Promise<Conversation[]>;
  send(creds: ChannelCredentials, net: ChannelNet, input: SendInput): Promise<{ messageId: string }>;
  edit(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; text: string }): Promise<void>;
  delete(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string }): Promise<void>;
  react(creds: ChannelCredentials, net: ChannelNet, input: { conversation: string; messageId: string; emoji: string }): Promise<void>;
  /** Open (or reuse) the direct conversation with one person; returns its conversation id. */
  openDirect(creds: ChannelCredentials, net: ChannelNet, input: { personId: string }): Promise<{ conversation: string }>;
  /**
   * Inbound. `socket` / `poll`: `run` loops until `signal` aborts, calling `sink` per message; it handles reconnects
   * and backoff itself and resolves only on abort (errors after a backoff are retried; a credential refusal throws
   * ChannelError("channel_credentials_rejected")). `webhook`: `verifyWebhook` checks one request (signature/JWT) and
   * returns the messages it carries; the app exposes it on a manifest public route.
   */
  inbound:
    | { kind: "socket" | "poll"; run(creds: ChannelCredentials, net: ChannelNet, bot: BotIdentity, sink: InboundSink, signal: AbortSignal): Promise<void> }
    | {
        kind: "webhook";
        verifyWebhook(
          request: { headers: Headers; body: string },
          creds: ChannelCredentials,
          net: ChannelNet,
          bot: BotIdentity,
        ): Promise<{ messages: InboundMessage[]; reply?: { status: number; body: string; contentType?: string } }>;
      };
}

const CONTROL = /[\p{Cc}\p{Cf}]/gu;
export const INBOUND_TEXT_MAX = 8_000;

export function cleanInboundText(text: string, max = INBOUND_TEXT_MAX): string {
  return text.replace(CONTROL, (c) => (c === "\n" || c === "\t" ? c : "")).slice(0, max);
}

/** Remove every credential value (≥ 6 chars) from a text before it reaches an error or a log. */
export function scrub(text: string, creds: ChannelCredentials): string {
  let out = text;
  for (const v of Object.values(creds)) if (v && v.length >= 6) out = out.split(v).join("[redacted]");
  return out;
}
