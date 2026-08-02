const SENSITIVE_KEY = /(cookie|password|token|secret|authorization|api[ _-]?key)/i;
const APIKEY_QUERY = /([?&]apikey=)[^&#\s"'<>]*/gi;
const HTTP_URL_USERINFO = /(\bhttps?:\/\/)[^/?#\s"'<>]+@/gi;
const ESCAPED_SERIALIZED_SECRET = /((\\["'])(?:password|token|access[_-]?token|refresh[_-]?token|secret|api[ _-]?key)\2\s*:\s*(\\["']))(?:\\\\.|(?!\3)[\s\S])*(\3)/gi;
const SERIALIZED_SECRET = /((["'])(?:password|token|access[_-]?token|refresh[_-]?token|secret|api[ _-]?key)\2\s*:\s*(["']))(?:\\.|(?!\3)[\s\S])*(\3)/gi;
const SECRET_ASSIGNMENT = /(\b(?:password|token|access[_-]?token|refresh[_-]?token|secret|api[ _-]?key)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#"'<>}\]]+)/gi;
const ESCAPED_SERIALIZED_HEADER_START = /((\\["'])(?:authorization|proxy-authorization|x-api-key|set-cookie|cookie)\2\s*:\s*(\\["']))/gi;
const SERIALIZED_HEADER_START = /((["'])(?:authorization|proxy-authorization|x-api-key|set-cookie|cookie)\2\s*:\s*(["']))/gi;
const AUTHORIZATION_HEADER = /(\b(?:proxy-authorization|authorization)\s*[:=]\s*(?:["'])?[a-z][a-z0-9+.-]*\s+)[^\s,"'<>}\]]+/gi;
const API_KEY_HEADER = /(\bx-api-key\s*[:=]\s*(?:["'])?)[^\s,"'<>}\]]+/gi;
const COOKIE_HEADER = /(\b(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]*/gi;

function redactSerializedHeaders(
  value: string,
  startPattern: RegExp,
  escaped: boolean,
): string {
  let output = value;
  startPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(output)) !== null) {
    const quote = match[3]?.at(-1);
    if (quote === undefined) continue;
    let end = startPattern.lastIndex;
    while (end < output.length) {
      if (output[end] === "\\") {
        let slashCount = 1;
        while (output[end + slashCount] === "\\") slashCount += 1;
        if (output[end + slashCount] === quote) {
          if (escaped && slashCount === 1) break;
          end += slashCount + 1;
          continue;
        }
        end += slashCount;
        continue;
      }
      if (!escaped && output[end] === quote) break;
      end += 1;
    }
    if (end >= output.length) continue;
    const delimiterLength = escaped ? 2 : 1;
    output = `${output.slice(0, startPattern.lastIndex)}[REDACTED]${output.slice(end, end + delimiterLength)}${output.slice(end + delimiterLength)}`;
    startPattern.lastIndex += "[REDACTED]".length + delimiterLength;
  }
  return output;
}

function redactString(value: string): string {
  const serializedHeadersRedacted = redactSerializedHeaders(
    redactSerializedHeaders(value, ESCAPED_SERIALIZED_HEADER_START, true),
    SERIALIZED_HEADER_START,
    false,
  );
  return serializedHeadersRedacted
    .replace(HTTP_URL_USERINFO, "$1")
    .replace(APIKEY_QUERY, "$1[REDACTED]")
    .replace(ESCAPED_SERIALIZED_SECRET, "$1[REDACTED]$4")
    .replace(SERIALIZED_SECRET, "$1[REDACTED]$4")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
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
