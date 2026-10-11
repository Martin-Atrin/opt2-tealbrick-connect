import { Button, Dialog, Tag, type Tone, Notice as UiNotice } from "@opt2-tealbrick/ui";
import type { ReactNode } from "react";

import type { AccountKind, AccountStatus } from "./ops.ts";

/** Status is always a text label (ui Tag), never a dot. */
const STATUS: Record<AccountStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "progress" },
  connected: { label: "Connected", tone: "ok" },
  failed: { label: "Failed", tone: "blocked" },
  revoked: { label: "Disconnected", tone: "neutral" },
};

export function StatusLabel({ status }: { status: AccountStatus }) {
  return <Tag tone={STATUS[status].tone}>{STATUS[status].label}</Tag>;
}

export function KindBadge({ kind }: { kind: AccountKind }) {
  return <Tag tone="neutral">{kind === "as_itself" ? "As itself" : "As me"}</Tag>;
}

export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <UiNotice tone={tone === "error" ? "action" : "ok"} role={tone === "error" ? "alert" : "status"}>
      {children}
    </UiNotice>
  );
}

export function ConfirmDialog(props: { open: boolean; title: string; body: ReactNode; confirmLabel: string; busy?: boolean; onConfirm(): void; onCancel(): void }) {
  return (
    <Dialog
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      {...(props.busy !== undefined ? { busy: props.busy } : {})}
      footer={
        <>
          <Button variant="secondary" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={props.onConfirm} disabled={props.busy}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      {props.body}
    </Dialog>
  );
}
