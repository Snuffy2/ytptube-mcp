const SENSITIVE_KEY = /(cookie|password|token|secret|authorization|api[ _-]?key)/i;
const APIKEY_QUERY = /([?&]apikey=)[^&#\s"'<>]*/gi;
const SERIALIZED_HEADER = /((["'])(?:authorization|proxy-authorization|x-api-key|set-cookie|cookie)\2\s*:\s*(["']))[^"'\\]*(\3)/gi;
const AUTHORIZATION_HEADER = /(\b(?:proxy-authorization|authorization)\s*[:=]\s*(?:["'])?(?:basic|bearer)\s+)[^\s,"'<>}\]]+/gi;
const API_KEY_HEADER = /(\bx-api-key\s*[:=]\s*(?:["'])?)[^\s,"'<>}\]]+/gi;
const COOKIE_HEADER = /(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi;

function redactString(value: string): string {
  return value
    .replace(APIKEY_QUERY, "$1[REDACTED]")
    .replace(SERIALIZED_HEADER, "$1[REDACTED]$4")
    .replace(AUTHORIZATION_HEADER, "$1[REDACTED]")
    .replace(API_KEY_HEADER, "$1[REDACTED]")
    .replace(COOKIE_HEADER, "$1[REDACTED]");
}

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
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
