import { type ReactNode, useEffect, useRef } from "react";

import type { AccountKind, AccountStatus } from "./ops.ts";

/** Status is always a text label, never a dot or an icon. */
const STATUS_LABEL: Record<AccountStatus, string> = { pending: "Pending", connected: "Connected", failed: "Failed", revoked: "Disconnected" };

export function StatusLabel({ status }: { status: AccountStatus }) {
  return <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function KindBadge({ kind }: { kind: AccountKind }) {
  return <span className="badge">{kind === "as_itself" ? "As itself" : "As me"}</span>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

export function ConfirmDialog(props: { open: boolean; title: string; body: ReactNode; confirmLabel: string; busy?: boolean; onConfirm(): void; onCancel(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { open } = props;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="confirm-title" onCancel={props.onCancel} onClose={props.onCancel}>
      <h2 id="confirm-title">{props.title}</h2>
      <div className="dialog-body">{props.body}</div>
      <div className="row row-end">
        <button type="button" className="btn" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" onClick={props.onConfirm} disabled={props.busy}>
          {props.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
