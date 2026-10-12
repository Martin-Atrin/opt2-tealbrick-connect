/**
 * Workspace sender identities (C86, SDK-API §18 "Cross-app contracts"). When the caller of a Connect send op is a
 * companion APP (`caller.type = "app"`), Connect sends from the identity the owner picked here, one per channel:
 * - `buzz`: a Buzz identity created for the workspace (key WORKSPACE_SENDER, sealed like agent keys);
 * - a chat service (slack, teams, telegram, discord): one connected channel account (bot) of that service.
 * An agent caller always keeps its own identity. No sender for the channel → refusal `no_sender_identity` (409, not
 * retryable). Chat senders are also a shared `account` scope instance `sender:<service>` (manifest defaultGrants
 * `shared`), so the SDK scope check lets companion apps reach exactly that sender and nothing else.
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

import { CHANNEL_SERVICES, type ChannelService } from "./channels/provider.ts";

export const SENDER_CHANNELS = ["buzz", ...CHANNEL_SERVICES] as const;
export type SenderChannel = (typeof SENDER_CHANNELS)[number];
/** Where the owner sets senders (named in every no_sender_identity refusal). */
export const SENDERS_PAGE = "Connect → Senders (/a/connect/configure#senders)";

export interface SenderRow {
  channel: SenderChannel;
  account: string | null;
  label: string;
  setAt: number;
}

export const isSenderChannel = (value: string): value is SenderChannel => (SENDER_CHANNELS as readonly string[]).includes(value);
export const senderScopeId = (service: ChannelService): string => `sender:${service}`;

export class SenderStore {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  get(channel: SenderChannel): SenderRow | null {
    const r = this.#db.prepare("SELECT channel, account, label, set_at FROM connect_senders WHERE channel = ?").get(channel);
    return r ? { channel: String(r.channel) as SenderChannel, account: r.account === null ? null : String(r.account), label: String(r.label), setAt: Number(r.set_at) } : null;
  }

  list(): SenderRow[] {
    return SENDER_CHANNELS.map((c) => this.get(c)).filter((r): r is SenderRow => r !== null);
  }

  set(channel: SenderChannel, account: string | null, label: string, now = Date.now()): SenderRow {
    this.#db
      .prepare(
        "INSERT INTO connect_senders (channel, account, label, set_at) VALUES (?, ?, ?, ?) ON CONFLICT (channel) DO UPDATE SET account = excluded.account, label = excluded.label, set_at = excluded.set_at",
      )
      .run(channel, account, label, now);
    return this.get(channel) as SenderRow;
  }

  clear(channel: SenderChannel): boolean {
    return Number(this.#db.prepare("DELETE FROM connect_senders WHERE channel = ?").run(channel).changes) > 0;
  }
}
