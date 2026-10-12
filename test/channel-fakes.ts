/** Fakes for channel provider contract tests: recorded-fixture fetch, controllable sleep, fake WebSocket. No network. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelNet } from "../src/channels/provider.ts";

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "channels", name), "utf8")) as T;
}

export interface Recorded {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Headers;
  body: any;
}
/** One answer, a list consumed in order (the last one repeats), or a function of the call. */
export type RecordedRoute = Recorded | Recorded[] | ((call: RecordedCall) => Recorded);

/** Fake fetch keyed by "METHOD /path" (pathname as sent, percent-encoding kept). Unknown routes answer 404. */
export function recordedFetch(routes: Record<string, RecordedRoute>) {
  const calls: RecordedCall[] = [];
  const used = new Map<string, number>();
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const call: RecordedCall = {
      method,
      url: String(input),
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    let answer: Recorded;
    if (route === undefined) answer = { status: 404, body: { message: "404: Not Found", code: 0 } };
    else if (typeof route === "function") answer = route(call);
    else if (Array.isArray(route)) {
      const i = used.get(key) ?? 0;
      used.set(key, i + 1);
      answer = route[Math.min(i, route.length - 1)] ?? {};
    } else answer = route;
    const status = answer.status ?? 200;
    const nullBody = status === 204 || answer.body === undefined;
    return new Response(nullBody ? null : JSON.stringify(answer.body), {
      status,
      headers: { ...(nullBody ? {} : { "content-type": "application/json" }), ...answer.headers },
    });
  }) as typeof fetch;
  return { impl, calls };
}

/** A sleep that resolves at once and records each wait. */
export function instantSleep() {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { sleep, waits };
}

/** A sleep the test resolves by hand (or that resolves when its signal aborts). */
export function manualSleep() {
  const entries: { ms: number; done: boolean; resolve: () => void }[] = [];
  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const entry = {
        ms,
        done: false,
        resolve: () => {
          if (entry.done) return;
          entry.done = true;
          resolve();
        },
      };
      entries.push(entry);
      if (signal?.aborted) entry.resolve();
      else signal?.addEventListener("abort", entry.resolve, { once: true });
    });
  /** Resolve the newest open sleep; returns its ms. */
  const fireLatest = (): number => {
    const open = entries.filter((e) => !e.done);
    const entry = open[open.length - 1];
    if (!entry) throw new Error("no open sleep");
    entry.resolve();
    return entry.ms;
  };
  const open = () => entries.filter((e) => !e.done).map((e) => e.ms);
  return { sleep, fireLatest, open, entries };
}

/** Let pending promise callbacks run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** WebSocket stand-in: records sent frames and close codes; the test drives server frames and closes. */
export class FakeSocket {
  readonly url: string;
  readonly sent: any[] = [];
  closedWith: number | null = null;
  binaryType = "blob";
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    this.closedWith = code;
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  serverClose(code: number): void {
    this.onclose?.({ code });
  }
}

export function fakeNet(input: { fetch?: typeof fetch; sleep?: ChannelNet["sleep"]; now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const net: ChannelNet = {
    fetch:
      input.fetch ??
      ((async () => {
        throw new Error("network not allowed in tests");
      }) as typeof fetch),
    webSocket: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    now: input.now ?? (() => 1_760_000_999_000),
    sleep: input.sleep ?? (async () => {}),
  };
  return { net, sockets };
}
