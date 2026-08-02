const SENSITIVE_KEY = /(cookie|password|token|secret|authorization|api[ _-]?key)/i;
const APIKEY_QUERY = /([?&]apikey=)[^&#\s"'<>]*/gi;

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value.replace(APIKEY_QUERY, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen),
      ]),
    );
  }
  return value;
}
