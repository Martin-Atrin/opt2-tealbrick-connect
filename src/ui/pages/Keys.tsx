/** Keys: whether each workspace key is set. Values are never shown (`tb.keys_status` answers set / not set only). */
import { EmptyState, Table, Tag } from "@opt2-tealbrick/ui";

import { LoadError, PageHead, PageNote } from "../components.tsx";
import { useLoad } from "../hooks.ts";
import { callOp } from "../sdk.ts";

type KeyRow = { name: string; required: boolean; present: boolean; source: string | null };

export function Keys() {
  const list = useLoad(() => callOp<{ keys: KeyRow[] }>("tb.keys_status", {}));
  const keys = list.data?.keys ?? [];
  return (
    <section className="app-page" aria-label="Keys">
      <PageHead title="Keys" />
      <PageNote>Connect never shows key values. Add or replace workspace keys on the key page that Tealbrick Portal opens for Connect.</PageNote>
      {list.error ? <LoadError message={list.error} busy={list.loading} onRetry={() => void list.reload()} /> : null}
      {list.loading && !list.data && !list.error ? (
        <p className="tb-soft" role="status">
          Loading keys.
        </p>
      ) : null}
      {list.data && keys.length === 0 ? <EmptyState title="Connect has no keys to set." /> : null}
      {keys.length > 0 ? (
        <Table aria-label="Keys">
          <tbody>
            {keys.map((k) => (
              <tr key={k.name}>
                <td>
                  <code className="tb-mono">{k.name}</code>
                </td>
                <td>
                  <Tag status={k.present ? "live" : k.required ? "needs-you" : "default"}>{k.present ? "Set" : "Not set"}</Tag>
                </td>
                <td className="tb-hint">{k.source ? (k.source === "app_own" ? "(Connect key)" : "(Workspace key)") : ""}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </section>
  );
}
