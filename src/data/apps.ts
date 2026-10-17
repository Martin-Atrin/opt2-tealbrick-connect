/**
 * Per-app sharing of connected accounts for the data_* ops (C230 R3; FOUNDRY-DESIGN v2 §3.4–3.5, the confused-deputy
 * ruling C169). The OWNER shares a connected chat account with one app, at a level:
 *   - `available`: data_catalog only (dataset names, kinds, approximate counts, history flag; no values)
 *   - `shared`:    data_pull as well (read only)
 * No row means not shared (the default). An agent can never share, widen or read these rows (person op `account_app_share`).
 *
 * Which product is calling: the SDK gives a handler the app caller's instance id and its manifest NAME (verified slice
 * `companionCallers`), not its product id. Connect maps the name to a product with the table below, the same way for all
 * three data ops and the sharing UI (the way Rules maps names). An unknown name is no app we know: it sees no account.
 * SPEC-GAP: `OpContext.caller.product` would remove this table (filed in the R3 report).
 */
import type { Db } from "@opt2-tealbrick/spec/sdk";

export const SHARE_LEVELS = ["none", "available", "shared"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export type StoredLevel = Exclude<ShareLevel, "none">;

/** Apps that read data through the data_* ops: product id → manifest name. Add a line to let another app be shared with. */
export const DATA_APPS: Readonly<Record<string, string>> = {
  knowledge: "Knowledge",
  observer: "Observer",
};

/** Manifest name of an installed Tealbrick app → product id (data apps only; every other name is unknown here). */
export function productOfAppName(name: string): string | null {
  for (const [product, appName] of Object.entries(DATA_APPS)) if (appName === name) return product;
  return null;
}

export const isDataApp = (product: string): boolean => Object.hasOwn(DATA_APPS, product);

export interface ShareRow {
  product: string;
  level: StoredLevel;
}

export class ShareStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  level(account: string, product: string): ShareLevel {
    const row = this.#db.prepare("SELECT level FROM connect_account_shares WHERE account_id = ? AND product = ?").get(account, product);
    return row ? (String(row.level) as StoredLevel) : "none";
  }

  /** `none` removes the row. */
  set(account: string, product: string, level: ShareLevel, now = Date.now()): void {
    if (level === "none") {
      this.#db.prepare("DELETE FROM connect_account_shares WHERE account_id = ? AND product = ?").run(account, product);
      return;
    }
    this.#db
      .prepare(
        `INSERT INTO connect_account_shares (account_id, product, level, set_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, product) DO UPDATE SET level = excluded.level, set_at = excluded.set_at`,
      )
      .run(account, product, level, now);
  }

  forAccount(account: string): ShareRow[] {
    return this.#db
      .prepare("SELECT product, level FROM connect_account_shares WHERE account_id = ? ORDER BY product")
      .all(account)
      .map((r) => ({ product: String(r.product), level: String(r.level) as StoredLevel }));
  }

  forProduct(product: string): { account: string; level: StoredLevel }[] {
    return this.#db
      .prepare("SELECT account_id, level FROM connect_account_shares WHERE product = ? ORDER BY account_id")
      .all(product)
      .map((r) => ({ account: String(r.account_id), level: String(r.level) as StoredLevel }));
  }

  clearAccount(account: string): void {
    this.#db.prepare("DELETE FROM connect_account_shares WHERE account_id = ?").run(account);
  }
}
