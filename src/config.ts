export type AuthMode = "basic" | "apikey";

export interface Config {
  baseUrl: URL;
  username?: string;
  password?: string;
  authMode: AuthMode;
  allowMutations: boolean;
  timeoutMs: number;
}

function requiredBaseUrl(value: string | undefined): URL {
  if (!value) throw new Error("YTPTUBE_BASE_URL is required");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("YTPTUBE_BASE_URL must use http or https");
  }
  url.search = "";
  url.hash = "";
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const username = env.YTPTUBE_USERNAME;
  const password = env.YTPTUBE_PASSWORD;
  if ((username === undefined) !== (password === undefined)) {
    throw new Error(
      "YTPTUBE_USERNAME and YTPTUBE_PASSWORD must be provided together",
    );
  }
  const authMode = env.YTPTUBE_AUTH_MODE ?? "basic";
  if (authMode !== "basic" && authMode !== "apikey") {
    throw new Error("YTPTUBE_AUTH_MODE must be basic or apikey");
  }
  const timeoutMs = Number(env.YTPTUBE_TIMEOUT_MS ?? "30000");
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 300_000
  ) {
    throw new Error("YTPTUBE_TIMEOUT_MS must be an integer from 100 to 300000");
  }
  return {
    baseUrl: requiredBaseUrl(env.YTPTUBE_BASE_URL),
    username,
    password,
    authMode,
    allowMutations: env.YTPTUBE_ALLOW_MUTATIONS === "true",
    timeoutMs,
  };
}
