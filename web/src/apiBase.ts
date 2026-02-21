const DEFAULT_API_BASE = 'http://localhost:4000/api';
const CONTAINER_ONLY_HOSTS = new Set(['server', 'db', 'worker', 'worker2', 'worker3']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function runtimeDefaultApiBase(): string {
  if (typeof window === 'undefined') {
    return DEFAULT_API_BASE;
  }
  const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
  const host = window.location.hostname || 'localhost';
  return `${protocol}://${host}:4000/api`;
}

export function resolveApiBaseUrl(raw?: string): string {
  const fallback = runtimeDefaultApiBase();
  const candidate = (raw ?? '').trim() || fallback;
  if (candidate.startsWith('/')) {
    return stripTrailingSlash(candidate);
  }

  try {
    const url = new URL(candidate);
    if (typeof window !== 'undefined') {
      const hostname = url.hostname.toLowerCase();
      const browserHost = window.location.hostname;
      const browserHostLower = browserHost.toLowerCase();
      const local = new URL(fallback);

      if (CONTAINER_ONLY_HOSTS.has(hostname)) {
        url.protocol = local.protocol;
        url.hostname = browserHost || local.hostname;
        url.port = local.port;
      } else if (LOOPBACK_HOSTS.has(hostname) && browserHost && !LOOPBACK_HOSTS.has(browserHostLower)) {
        // LAN access: localhost in bundle should point to the host serving the page.
        url.hostname = browserHost;
      }
    }
    return stripTrailingSlash(url.toString());
  } catch {
    return fallback;
  }
}

export function getApiBaseUrl(): string {
  return resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
}
