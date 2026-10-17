/**
 * The `messages` dataset of the data_* op family (C230 R3; contract `messages/1`, spec-v0.1.42, FOUNDRY-DESIGN v2 §3.4).
 * Source: Connect's inbound log (`connect_channel_inbox`) of one connected chat account. One row per message; the pull
 * order is `rev` (a new message, an edit or a deletion each take the next number), so a forward cursor also sees changes
 * to rows it already passed. Consumers dedupe on (account, conversation, id) and keep the row with the newest content.
 *
 * Every page is validated against the vendored frozen schema (`src/contracts/messages.1.schema.json`, byte copy, see
 * `test/contracts/PROVENANCE.md`) before it leaves this module. A mismatch is a producer bug: `data_contract_violation`
 * (500), never a page that does not conform.
 *
 * What Connect can read today: the inbound log of Slack, Teams, Telegram and Discord (kept INBOX_RETENTION_MS = 30 days,
 * the minimum for apps is 7 days). No provider has a history reader yet, so `history` is false and a backward pull
 * answers `exhausted: true`; a service whose provider sets `readsHistory` pages backward through the log.
 *
 * `rev` is a per-account sequence and a cursor names its account (`m2:<account>:<rev>`): a cursor shows nothing about
 * other accounts' traffic and is refused on another account. A stored row that does not conform to messages/1 is
 * quarantined: skipped, counted (`quarantined` on the answer), logged with its rev, and the page stays valid.
 */
import { createHash } from "node:crypto";
import { HANDLE_CHANNELS, normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { JsonSchemaObject } from "@opt2-tealbrick/spec/manifest";
import type { Db, Json, Logger } from "@opt2-tealbrick/spec/sdk";

import type { Account } from "../accounts.ts";
import messagesSchema from "../contracts/messages.1.schema.json" with { type: "json" };

export const MESSAGES_DATASET = "messages";
export const MESSAGES_CONTRACT = "messages/1";
export const PAGE_MAX_ROWS = 200;
export const PAGE_DEFAULT_ROWS = 100;
/** S-7: one page is at most 2 MiB serialized. The row budget leaves room for the envelope. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const ROW_BUDGET_BYTES = PAGE_MAX_BYTES - 8 * 1024;
export const TEXT_MAX = 65_536;
export const ATTACHMENTS_MAX = 32;
const CATALOG_CONVERSATIONS = 200;

/** A refusal of a data op: a stable code and an HTTP status (the app maps it to the SDK error). */
export class DataError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = "DataError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** A source that is rate limited throws this; the page answers empty with `retryAfterS` (1..3600) and the same cursor. */
export class RetryLater extends Error {
  readonly retryAfterS: number;
  constructor(retryAfterS: number) {
    super("rate limited");
    this.name = "RetryLater";
    this.retryAfterS = Math.max(1, Math.min(3600, Math.ceil(retryAfterS)));
  }
}

export type Direction = "forward" | "backward";

export interface PullInput {
  direction: Direction;
  /** opaque cursor from an earlier answer, or null for the start (forward: the oldest kept row; backward: the newest) */
  cursor: string | null;
  /** inclusive lower bound on `sentAt`, epoch ms */
  since: number | null;
  /** exclusive upper bound on `sentAt`, epoch ms */
  until: number | null;
  /** only rows Connect received at or after this time, epoch ms (the share's start); null = the whole log */
  ingestedFrom: number | null;
  limit: number;
}

export interface MessageRow {
  id: string;
  conversation: string;
  thread?: string;
  sentAt: string;
  editedAt?: string;
  deleted?: boolean;
  author: { kind: "person" | "bot" | "self"; handle: string; display?: string };
  text: string;
  attachments: { name: string; mime: string; bytes: number }[];
  untrusted: true;
  truncated?: boolean;
  attachmentsTruncated?: boolean;
}

export interface MessagesPage {
  rows: MessageRow[];
  nextCursor: string | null;
  anchor?: string;
  exhausted: boolean;
  retryAfterS?: number;
  /** extra member (the contract allows them): stored rows skipped because they did not conform to messages/1 */
  quarantined?: number;
}

interface LogRow {
  rev: number;
  conversation: string;
  messageId: string;
  threadId: string | null;
  senderId: string;
  senderName: string;
  text: string;
  sentAt: number;
  receivedAt: number;
  editedAt: number | null;
  deleted: boolean;
  attachments: string | null;
  senderIsBot: boolean;
}

/** Where the rows come from. Production: the inbound log. A provider history reader (later) or a test replaces it. */
export type ReadRows = (accountId: string, input: PullInput, fetchRows: number) => LogRow[];

export interface MessagesDeps {
  db: Db;
  log?: Logger;
  /** the bot's own user id on the service (rows it wrote read as author `self`), or null */
  botId(accountId: string): string | null;
  /** true when the service's provider can page backward */
  history(service: string): boolean;
  /** test seam: another row source */
  read?: ReadRows;
}

// ── cursors ──

export function encodeCursor(account: string, rev: number): string {
  return Buffer.from(`m2:${account}:${rev}`).toString("base64url");
}

export function decodeCursor(cursor: string, account: string): number {
  const decoded = cursor.length > 512 ? "" : Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^m2:([A-Za-z0-9_-]{1,64}):(\d{1,15})$/u.exec(decoded);
  if (!match || match[1] !== account) throw new DataError("cursor_invalid", "cursor is not one data_pull returned for this account and dataset.");
  return Number(match[2]);
}

// ── rows ──

const CONTROL = /[\p{Cc}\p{Cf}]/gu;

const clipChars = (value: string, max: number): string => (value.length <= max ? value : Array.from(value).slice(0, max).join(""));

/** `id` and `conversation` are 1..200 characters in the contract; a longer provider id becomes a stable hash. */
function fit(value: string): string {
  return value.length <= 200 ? value : `h:${createHash("sha256").update(value).digest("hex")}`;
}

function isoOf(ms: number, fallback: number): string {
  for (const t of [ms, fallback]) {
    const d = new Date(t);
    if (Number.isFinite(t) && !Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 1970 && d.getUTCFullYear() <= 9999) return d.toISOString();
  }
  return new Date(0).toISOString();
}

/**
 * `author.handle` = "<channel>:<value>". Canonical (`normalizeHandle`) for the channels it knows (buzz, slack, telegram);
 * the raw `<channel>:<provider id>` for the others (Teams, Discord). When a known channel's id cannot be normalised
 * (for example a Slack bot id), the raw form is used and a warning is logged: dropping the message would be silent loss.
 */
export function authorHandle(service: string, senderId: string, log?: Logger): string {
  const id = senderId.replace(CONTROL, "").trim().slice(0, 200) || "unknown";
  const raw = `${service}:${id}`;
  if ((HANDLE_CHANNELS as readonly string[]).includes(service)) {
    const canonical = normalizeHandle(raw);
    if (canonical) return canonical;
    log?.warn("data: sender id is not canonical for its channel; raw handle used", { channel: service });
  }
  return raw.slice(0, 256);
}

function attachmentsOf(raw: string | null): { list: MessageRow["attachments"]; truncated: boolean } {
  if (!raw) return { list: [], truncated: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { list: [], truncated: false };
  }
  if (!Array.isArray(parsed)) return { list: [], truncated: false };
  const list: MessageRow["attachments"] = [];
  for (const a of parsed) {
    if (list.length >= ATTACHMENTS_MAX) break;
    if (!a || typeof a !== "object") continue;
    const { name, mime, bytes } = a as Record<string, unknown>;
    list.push({
      name: clipChars(typeof name === "string" ? name.replace(CONTROL, "") : "file", 255) || "file",
      mime: clipChars(typeof mime === "string" ? mime.replace(CONTROL, "") : "application/octet-stream", 127) || "application/octet-stream",
      bytes: typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? bytes : 0,
    });
  }
  return { list, truncated: parsed.length > ATTACHMENTS_MAX };
}

export function toRow(service: string, botId: string | null, r: LogRow, log?: Logger): MessageRow {
  const mine = botId !== null && r.senderId.toLowerCase() === botId.toLowerCase();
  const display = clipChars(r.senderName.replace(CONTROL, "").trim(), 128);
  const kind = mine ? "self" : r.senderIsBot ? "bot" : "person";
  // A bot's id is not always a user id (a Slack bot id): its raw handle is expected, so no warning.
  const author: MessageRow["author"] = { kind, handle: authorHandle(service, r.senderId, r.senderIsBot ? undefined : log), ...(display ? { display } : {}) };
  const base = {
    id: fit(r.messageId),
    conversation: fit(r.conversation),
    ...(r.threadId ? { thread: fit(r.threadId) } : {}),
    sentAt: isoOf(r.sentAt, r.receivedAt),
    ...(r.editedAt !== null ? { editedAt: isoOf(r.editedAt, r.receivedAt) } : {}),
    author,
    untrusted: true as const,
  };
  if (r.deleted) return { ...base, deleted: true, text: "", attachments: [] };
  const cut = r.text.length > TEXT_MAX && Array.from(r.text).length > TEXT_MAX;
  const text = cut ? clipChars(r.text, TEXT_MAX) : r.text;
  const files = attachmentsOf(r.attachments);
  return { ...base, text, attachments: files.list, ...(cut ? { truncated: true } : {}), ...(files.truncated ? { attachmentsTruncated: true } : {}) };
}

// ── the inbound log as a source ──

function logRow(r: Record<string, unknown>): LogRow {
  return {
    rev: Number(r.rev),
    conversation: String(r.conversation),
    messageId: String(r.message_id),
    threadId: r.thread_id === null || r.thread_id === undefined || r.thread_id === "" ? null : String(r.thread_id),
    senderId: String(r.sender_id),
    senderName: String(r.sender_name),
    text: String(r.text),
    sentAt: Number(r.sent_at),
    receivedAt: Number(r.received_at),
    editedAt: r.edited_at === null || r.edited_at === undefined ? null : Number(r.edited_at),
    deleted: Number(r.deleted) === 1,
    attachments: r.attachments === null || r.attachments === undefined ? null : String(r.attachments),
    senderIsBot: Number(r.sender_is_bot) === 1,
  };
}

export function readLog(db: Db): ReadRows {
  return (accountId, input, fetchRows) => {
    const where = ["account_id = ?"];
    const params: unknown[] = [accountId];
    if (input.cursor !== null) {
      where.push(input.direction === "forward" ? "rev > ?" : "rev < ?");
      params.push(decodeCursor(input.cursor, accountId));
    }
    if (input.ingestedFrom !== null) {
      where.push("received_at >= ?");
      params.push(input.ingestedFrom);
    }
    if (input.since !== null) {
      where.push("sent_at >= ?");
      params.push(input.since);
    }
    if (input.until !== null) {
      where.push("sent_at < ?");
      params.push(input.until);
    }
    const order = input.direction === "forward" ? "ASC" : "DESC";
    return db
      .prepare(`SELECT * FROM connect_channel_inbox WHERE ${where.join(" AND ")} AND rev IS NOT NULL ORDER BY rev ${order} LIMIT ?`)
      .all(...params, fetchRows)
      .map(logRow);
  };
}

function headRev(db: Db, accountId: string, ingestedFrom: number | null): number | null {
  const r = db
    .prepare(`SELECT MAX(rev) AS rev FROM connect_channel_inbox WHERE account_id = ?${ingestedFrom === null ? "" : " AND received_at >= ?"}`)
    .get(...(ingestedFrom === null ? [accountId] : [accountId, ingestedFrom]));
  return r?.rev === null || r?.rev === undefined ? null : Number(r.rev);
}

// ── validation ──

/** Check a page against the frozen contract and the size caps. Throws `data_contract_violation` (500). */
export function assertConforms(page: MessagesPage, log?: Logger): void {
  const problems: string[] = [];
  const checked = validateAgainstSchema(messagesSchema as unknown as JsonSchemaObject, page as unknown as Json);
  if (!checked.ok) for (const e of checked.errors.slice(0, 5)) problems.push(`${e.path || "/"} ${e.message}`);
  const bytes = Buffer.byteLength(JSON.stringify(page));
  if (bytes > PAGE_MAX_BYTES) problems.push(`page is ${bytes} bytes; the cap is ${PAGE_MAX_BYTES}`);
  if (problems.length === 0) return;
  // Paths and rule names only: a page's values are untrusted message content and stay out of logs and errors.
  log?.error("data_pull: page does not conform to messages/1", { problems: problems.join("; ").slice(0, 600) });
  throw new DataError("data_contract_violation", "The page did not conform to the messages/1 contract and was not returned.", 500);
}

// ── pull ──

const rowSchema = { $schema: messagesSchema.$schema, $defs: messagesSchema.$defs, $ref: "#/$defs/row" } as unknown as JsonSchemaObject;

export function pullMessages(deps: MessagesDeps, account: Account, input: PullInput): MessagesPage {
  const limit = Math.max(1, Math.min(PAGE_MAX_ROWS, Math.trunc(input.limit) || PAGE_DEFAULT_ROWS));
  const cursor = input.cursor;
  if (cursor !== null) decodeCursor(cursor, account.id);
  const anchorRev = cursor === null ? headRev(deps.db, account.id, input.ingestedFrom) : null;
  const anchor = anchorRev === null ? {} : { anchor: encodeCursor(account.id, anchorRev) };

  let page: MessagesPage;
  if (input.direction === "backward" && !deps.history(account.service)) {
    // No provider history reader: there is nothing older than what a forward pull from the start already gives.
    page = { rows: [], nextCursor: null, ...anchor, exhausted: true };
  } else {
    let fetched: LogRow[];
    try {
      fetched = (deps.read ?? readLog(deps.db))(account.id, { ...input, limit }, limit + 1);
    } catch (error) {
      if (!(error instanceof RetryLater)) throw error;
      page = { rows: [], nextCursor: cursor, ...anchor, exhausted: false, retryAfterS: error.retryAfterS };
      assertConforms(page, deps.log);
      return page;
    }
    const botId = deps.botId(account.id);
    const rows: MessageRow[] = [];
    let used = 0;
    let lastRev: number | null = null;
    let quarantined = 0;
    let taken = 0;
    for (const r of fetched.slice(0, limit)) {
      const quarantine = (why: string) => {
        quarantined += 1;
        // Rev, account and the rule that failed only: the row's values are untrusted message content.
        deps.log?.error("data_pull: a stored row does not conform to messages/1 and was skipped", { account: account.id, rev: r.rev, why: why.slice(0, 200) });
      };
      let row: MessageRow | null = null;
      try {
        row = toRow(account.service, botId, r, deps.log);
        const checked = validateAgainstSchema(rowSchema, row as unknown as Json);
        if (!checked.ok) {
          quarantine(checked.errors.slice(0, 3).map((e) => `${e.path || "/"} ${e.message}`).join("; "));
          row = null;
        }
      } catch (error) {
        quarantine(error instanceof Error ? error.message : "row could not be built");
      }
      if (row) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length > 0 && used + size > ROW_BUDGET_BYTES) break;
        rows.push(row);
        used += size;
      }
      lastRev = r.rev;
      taken += 1;
    }
    const exhausted = taken === fetched.length;
    // Forward keeps a cursor even when exhausted (the caller polls for newer rows from it); backward ends with null.
    const next = lastRev !== null ? encodeCursor(account.id, lastRev) : cursor;
    page = { rows, nextCursor: input.direction === "backward" && exhausted ? null : next, ...anchor, exhausted, ...(quarantined > 0 ? { quarantined } : {}) };
  }
  assertConforms(page, deps.log);
  return page;
}

// ── catalog ──

export interface CatalogDataset {
  dataset: string;
  title: string;
  kind: "messages";
  delivery: "pull";
  contract: string;
  approxRows: number;
  /** true when data_pull can page backward past what a forward pull from the start returns */
  history: boolean;
  /** how long the log keeps rows, days */
  retentionDays: number;
  /** true when the provider reports edits of logged messages (otherwise the log keeps the old text) */
  edits: boolean;
  /** true when the provider reports deletions (otherwise a deleted message keeps its text until the purge) */
  deletions: boolean;
  oldestAt?: string;
  conversations: { id: string; name: string; type: string; approxRows: number }[];
}

export function messagesCatalog(db: Db, account: Account, history: boolean, retentionMs: number, reports: { edits: boolean; deletions: boolean }): CatalogDataset {
  const total = db.prepare("SELECT COUNT(*) AS n, MIN(sent_at) AS oldest FROM connect_channel_inbox WHERE account_id = ? AND rev IS NOT NULL").get(account.id);
  const conversations = db
    .prepare(
      `SELECT c.conversation, c.name, c.type, COUNT(i.seq) AS n FROM connect_channel_conversations c
       LEFT JOIN connect_channel_inbox i ON i.account_id = c.account_id AND i.conversation = c.conversation AND i.deleted = 0
       WHERE c.account_id = ? GROUP BY c.conversation, c.name, c.type ORDER BY n DESC, c.name, c.conversation LIMIT ?`,
    )
    .all(account.id, CATALOG_CONVERSATIONS)
    .map((r) => ({
      id: fit(String(r.conversation)),
      name: clipChars(String(r.name).replace(CONTROL, ""), 120),
      type: String(r.type),
      approxRows: Number(r.n),
    }));
  const oldest = total?.oldest === null || total?.oldest === undefined ? null : Number(total.oldest);
  return {
    dataset: MESSAGES_DATASET,
    title: "Messages",
    kind: "messages",
    delivery: "pull",
    contract: MESSAGES_CONTRACT,
    approxRows: Number(total?.n ?? 0),
    history,
    retentionDays: Math.round(retentionMs / 86_400_000),
    edits: reports.edits,
    deletions: reports.deletions,
    ...(oldest !== null ? { oldestAt: isoOf(oldest, oldest) } : {}),
    conversations,
  };
}
