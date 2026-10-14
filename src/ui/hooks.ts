import { useCallback, useEffect, useRef, useState } from "react";

import { TbError } from "./sdk.ts";

export function errorText(error: unknown): string {
  if (error instanceof TbError) return error.message;
  return error instanceof Error ? error.message : "Something went wrong.";
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): Promise<void>;
}

/** Run `load` on mount (and when `key` changes); the latest call wins. */
export function useLoad<T>(load: () => Promise<T>, key = ""): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const run = useRef(0);
  const loader = useRef(load);
  loader.current = load;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the explicit re-run trigger
  const reload = useCallback(async () => {
    const mine = ++run.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loader.current();
      if (mine === run.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (mine === run.current) setState((s) => ({ data: s.data, error: errorText(error), loading: false }));
    }
  }, [key]);
  useEffect(() => {
    void reload();
    return () => {
      run.current++;
    };
  }, [reload]);
  return { ...state, reload };
}

/** Copy text; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
