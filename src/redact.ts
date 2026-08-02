const SENSITIVE_KEY = /(cookie|password|token|secret|authorization|api[ _-]?key)/i;
const APIKEY_QUERY = /([?&]apikey=)[^&#\s"'<>]*/gi;
const HTTP_URL_USERINFO = /(\bhttps?:\/\/)[^/?#\s"'<>]+@/gi;
const ESCAPED_SERIALIZED_SECRET = /((\\["'])(?:password|token|access[_-]?token|refresh[_-]?token|secret|api[ _-]?key)\2\s*:\s*(\\["']))(?:\\\\.|(?!\3)[\s\S])*(\3)/gi;
const SERIALIZED_SECRET = /((["'])(?:password|token|access[_-]?token|refresh[_-]?token|secret|api[ _-]?key)\2\s*:\s*(["']))(?:\\.|(?!\3)[\s\S])*(\3)/gi;
const SECRET_ASSIGNMENT = /(\b(?:password|token|access[_-]?token|refresh[_-]?token|secret|api[ _-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#"'<>}\]]+)/gi;
const ESCAPED_SERIALIZED_HEADER = /((\\["'])(?:authorization|proxy-authorization|x-api-key|set-cookie|cookie)\2\s*:\s*(\\["']))[^"'\\]*(\3)/gi;
const SERIALIZED_HEADER = /((["'])(?:authorization|proxy-authorization|x-api-key|set-cookie|cookie)\2\s*:\s*(["']))[^"'\\]*(\3)/gi;
const AUTHORIZATION_HEADER = /(\b(?:proxy-authorization|authorization)\s*[:=]\s*(?:["'])?[a-z][a-z0-9+.-]*\s+)[^\s,"'<>}\]]+/gi;
const API_KEY_HEADER = /(\bx-api-key\s*[:=]\s*(?:["'])?)[^\s,"'<>}\]]+/gi;
const COOKIE_HEADER = /(\b(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]*/gi;

function redactString(value: string): string {
  return value
    .replace(HTTP_URL_USERINFO, "$1")
    .replace(APIKEY_QUERY, "$1[REDACTED]")
    .replace(ESCAPED_SERIALIZED_SECRET, "$1[REDACTED]$4")
    .replace(SERIALIZED_SECRET, "$1[REDACTED]$4")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(ESCAPED_SERIALIZED_HEADER, "$1[REDACTED]$4")
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
