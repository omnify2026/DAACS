import {
  COOKIE_NAME_CSRF,
  DEFAULT_API_BASE,
  HEADER_NAME_CSRF,
  STORAGE_KEY_ACCESS_TOKEN,
} from "../constants";
import { appApiStub, isAppApiStubEnabled } from "./appApiStub";
import { isTauri } from "./tauriCli";

export interface ApiErrorShape {
  status: number;
  body: string;
}

let volatileAuthToken: string | null = null;

export function setAuthToken(token: string | null): void {
  if (typeof window === "undefined") {
    volatileAuthToken = token;
    return;
  }
  try {
    if (token) {
      volatileAuthToken = token;
      window.localStorage.setItem(STORAGE_KEY_ACCESS_TOKEN, token);
      return;
    }
    window.localStorage.removeItem(STORAGE_KEY_ACCESS_TOKEN);
    volatileAuthToken = null;
  } catch {
    // Keep auth flows functional even when storage is blocked.
  }
}

export function getAuthToken(): string | null {
  if (typeof window === "undefined") {
    return volatileAuthToken;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY_ACCESS_TOKEN) ?? volatileAuthToken;
  } catch {
    return volatileAuthToken;
  }
}

function getCookieValue(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") {
    return null;
  }

  const target = `${encodeURIComponent(name)}=`;
  for (const rawPart of document.cookie.split(";")) {
    const part = rawPart.trim();
    if (!part.startsWith(target)) {
      continue;
    }

    const value = part.slice(target.length);
    if (!value) {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

function resolveApiBase(): string {
  const configuredBase =
    typeof import.meta.env?.VITE_API_BASE_URL === "string" ? import.meta.env.VITE_API_BASE_URL.trim() : "";

  if (configuredBase) {
    return configuredBase.replace(/\/+$/, "");
  }
  if (isTauri()) {
    return DEFAULT_API_BASE;
  }
  return "";
}

function resolveRequestUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (path.startsWith("/")) {
    return `${resolveApiBase()}${path}`;
  }
  return `${resolveApiBase()}/${path}`;
}

async function parseResponseBody(response: Response): Promise<string> {
  if (response.status === 204) {
    return "";
  }
  return response.text();
}

export async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  includeAuth = true,
): Promise<T> {
  if (isAppApiStubEnabled()) {
    const method = (options.method ?? "GET").toUpperCase();
    const body = typeof options.body === "string" ? options.body : null;
    return Promise.resolve(appApiStub<T>(path, method, body));
  }

  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers ?? {});

  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }

  if (typeof options.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (method !== "GET" && method !== "HEAD" && !headers.has(HEADER_NAME_CSRF)) {
    const csrfToken = getCookieValue(COOKIE_NAME_CSRF);
    if (csrfToken) {
      headers.set(HEADER_NAME_CSRF, csrfToken);
    }
  }

  const token = includeAuth ? getAuthToken() : null;
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(resolveRequestUrl(path), {
    ...options,
    method,
    headers,
    credentials: options.credentials ?? "include",
  });

  const rawBody = await parseResponseBody(response);
  if (!response.ok) {
    throw {
      status: response.status,
      body: rawBody,
    } satisfies ApiErrorShape;
  }

  if (!rawBody) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return JSON.parse(rawBody) as T;
  }

  return rawBody as T;
}
