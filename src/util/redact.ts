const SENSITIVE_KEY = /key|token|secret|authorization|credential|password|cookie/iu;

/** Replace values under sensitive-looking keys before an upstream payload is logged or stored (v1 provider-health.ts:46-59). */
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[redacted]" : redactDeep(entry),
    ]),
  );
}

/** Remove every occurrence of the given secret values from a text (response bodies, error messages). */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}
