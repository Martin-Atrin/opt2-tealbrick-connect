import { Button, Dialog, type Status, Tag, Notice as UiNotice } from "@opt2-tealbrick/ui";
import type { ReactNode } from "react";

import type { AccountKind, AccountStatus } from "./ops.ts";

/** Status is always a text label (ui Tag), never a dot. */
const STATUS: Record<AccountStatus, { label: string; status: Status }> = {
  pending: { label: "Pending", status: "busy" },
  connected: { label: "Connected", status: "live" },
  failed: { label: "Failed", status: "needs-you" },
  revoked: { label: "Disconnected", status: "idle" },
};

export function StatusLabel({ status }: { status: AccountStatus }) {
  return <Tag status={STATUS[status].status}>{STATUS[status].label}</Tag>;
}

export function KindBadge({ kind }: { kind: AccountKind }) {
  return <Tag>{kind === "as_itself" ? "As itself" : "As me"}</Tag>;
}

/** `error` is read out at once (role alert); `ok` is a finished action; `info` is plain information. */
export function Notice({ tone = "info", children }: { tone?: "info" | "ok" | "error"; children: ReactNode }) {
  return (
    <UiNotice tone={tone === "error" ? "needs-you" : tone === "ok" ? "live" : "neutral"} role={tone === "error" ? "alert" : "status"}>
      {children}
    </UiNotice>
  );
}

/**
 * The page heading of the mockups. With a lede (Services, Accounts) the lede stacks under the h1, as in the approved
 * mockup (`.page-head > .tb-stack`); pages without a lede put their sentence in a body `PageNote` after the head.
 */
export function PageHead({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <div className="page-head">
      {lede ? (
        <div className="tb-stack head-stack">
          <h1>{title}</h1>
          <p className="tb-lede">{lede}</p>
        </div>
      ) : (
        <h1>{title}</h1>
      )}
    </div>
  );
}

/** The sentence under a page heading on the mockups' simple pages (Buzz, Chat bots, Senders, Keys): body text, 62ch. */
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="tb-soft page-note">{children}</p>;
}

/** A long identity (npub, bot id) shortened in the middle, as the mockups show it: `npub180cvv07t…h6w6`. */
export function shortId(value: string, head = 12, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** A failed load (RUL-14): the cause and a way to try again, never an empty list that looks like "nothing here". */
export function LoadError({ message, onRetry, busy }: { message: string; onRetry(): void; busy?: boolean }) {
  return (
    <UiNotice tone="needs-you" role="alert">
      <span className="tb-row">
        <span>{message}</span>
        <Button size="sm" onClick={onRetry} disabled={busy}>
          Try again
        </Button>
      </span>
    </UiNotice>
  );
}

/** The service letter tile of the mockups: the first letter of a name (decorative). */
export function ServiceTile({ name }: { name: string }) {
  return (
    <span className="svc" aria-hidden="true">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
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
          <Button onClick={props.onCancel} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant="danger" confirm onClick={props.onConfirm} disabled={props.busy}>
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      {props.body}
    </Dialog>
  );
}
