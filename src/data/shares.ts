/**
 * Per-app sharing of connected accounts for the data_* ops (C230 R3; FOUNDRY-DESIGN v2 §3.4–3.5, the confused-deputy
 * ruling C169). The OWNER shares a connected chat account with one app, at a level:
 *   - `available`: data_catalog only (dataset names, kinds, approximate counts, conversation names, history flag; no message)
 *   - `shared`:    data_pull as well (read only)
 * No row means not shared (the default). An agent can never share, widen or read these rows (person op `account_app_share`).
 *
 * `set_at` is when the share began (it moves when the level or the history choice changes). A pull returns only messages
 * Connect received at or after it, unless the owner chose `includeHistory` (the whole log, 30 days).
 * Who the calling app is: see `caller.ts` (the verified product, never a name).
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

export const SHARE_LEVELS = ["none", "available", "shared"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export type StoredLevel = Exclude<ShareLevel, "none">;

/** Apps the owner can share with: product id → name shown in the UI (a display list, not an identity table). */
export const DATA_APPS: Readonly<Record<string, string>> = {
  knowledge: "Knowledge",
  observer: "Observer",
};

export const isDataApp = (product: string): boolean => Object.hasOwn(DATA_APPS, product);

export interface ShareRow {
  product: string;
  level: StoredLevel;
  includeHistory: boolean;
  /** epoch ms */
  setAt: number;
}

const rowOf = (r: Record<string, unknown>): ShareRow => ({
  product: String(r.product),
  level: String(r.level) as StoredLevel,
  includeHistory: Number(r.include_history) === 1,
  setAt: Number(r.set_at),
});

export class ShareStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(account: string, product: string): ShareRow | null {
    const row = this.#db.prepare("SELECT * FROM connect_account_shares WHERE account_id = ? AND product = ?").get(account, product);
    return row ? rowOf(row) : null;
  }

  level(account: string, product: string): ShareLevel {
    return this.get(account, product)?.level ?? "none";
  }

  /** `none` removes the row. A call that changes nothing keeps `set_at`; a change moves it to now. */
  set(account: string, product: string, level: ShareLevel, includeHistory = false, now = Date.now()): void {
    if (level === "none") {
      this.#db.prepare("DELETE FROM connect_account_shares WHERE account_id = ? AND product = ?").run(account, product);
      return;
    }
    const current = this.get(account, product);
    if (current && current.level === level && current.includeHistory === includeHistory) return;
    this.#db
      .prepare(
        `INSERT INTO connect_account_shares (account_id, product, level, include_history, set_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (account_id, product) DO UPDATE SET level = excluded.level, include_history = excluded.include_history, set_at = excluded.set_at`,
      )
      .run(account, product, level, includeHistory ? 1 : 0, now);
  }

  forAccount(account: string): ShareRow[] {
    return this.#db.prepare("SELECT * FROM connect_account_shares WHERE account_id = ? ORDER BY product").all(account).map(rowOf);
  }

  forProduct(product: string): (ShareRow & { account: string })[] {
    return this.#db
      .prepare("SELECT * FROM connect_account_shares WHERE product = ? ORDER BY account_id")
      .all(product)
      .map((r) => ({ ...rowOf(r), account: String(r.account_id) }));
  }

  clearAccount(account: string): void {
    this.#db.prepare("DELETE FROM connect_account_shares WHERE account_id = ?").run(account);
  }
}
