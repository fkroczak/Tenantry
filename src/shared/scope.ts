/**
 * Domains, auf die Tenantry die Container-Isolierung anwendet.
 *
 * WICHTIG: Bei Änderungen auch `host_permissions` und `content_scripts.matches`
 * in static/manifest.json anpassen. Ein Unit-Test (test/scope.test.ts)
 * prüft, dass beide Listen zusammenpassen.
 */
export interface ScopeEntry {
  /** Domain ohne führenden Punkt. */
  domain: string;
  /** true = Domain selbst und alle Subdomains (entspricht "*.domain"). */
  includeSubdomains: boolean;
  /** true = nicht in der ursprünglichen Anforderung, aber für reale Login-Flows nötig. */
  extension?: boolean;
}

export const SCOPE: readonly ScopeEntry[] = [
  { domain: 'login.microsoftonline.com', includeSubdomains: false },
  { domain: 'login.live.com', includeSubdomains: false },
  { domain: 'office.com', includeSubdomains: true }, // inkl. outlook.office.com
  { domain: 'microsoft.com', includeSubdomains: true }, // inkl. admin.microsoft.com, entra.microsoft.com
  { domain: 'sharepoint.com', includeSubdomains: true },
  { domain: 'portal.azure.com', includeSubdomains: true },
  // Ergänzungen: Microsoft leitet Admin Center/Outlook/M365 zunehmend auf
  // *.cloud.microsoft bzw. outlook.office365.com um.
  { domain: 'cloud.microsoft', includeSubdomains: true, extension: true },
  { domain: 'office365.com', includeSubdomains: true, extension: true },
  { domain: 'login.windows.net', includeSubdomains: false, extension: true },
];

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
}

export function inScope(host: string): boolean {
  const h = normalizeHost(host);
  return SCOPE.some((e) => h === e.domain || (e.includeSubdomains && h.endsWith('.' + e.domain)));
}

export function urlInScope(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && inScope(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Vereinfachte "Site" (eTLD+1). Alle Scope-Domains haben einstufige TLDs
 * (.com, .net, .microsoft), daher genügen die letzten zwei Labels.
 */
export function siteOf(host: string): string {
  const labels = normalizeHost(host).split('.');
  return labels.slice(-2).join('.');
}

/** Für DNR `requestDomains` (matcht Domain + Subdomains). */
export const SCOPE_REQUEST_DOMAINS: readonly string[] = SCOPE.map((e) => e.domain);

/** Chrome-Match-Patterns, z. B. für webRequest-Filter. */
export const SCOPE_MATCH_PATTERNS: readonly string[] = SCOPE.map((e) =>
  e.includeSubdomains ? `https://*.${e.domain}/*` : `https://${e.domain}/*`,
);

/**
 * Zusätzliche Host-Berechtigungen NUR für chrome.cookies: Chrome zeigt/löscht
 * Cookies mit z. B. `Domain=microsoftonline.com` nur mit Berechtigung für genau
 * diese Apex-Domain. Ohne sie blieben native Kopien solcher Container-Cookies
 * liegen und würden in Tabs ohne Container mitgesendet.
 */
export const COOKIE_APEX_PERMISSIONS: readonly string[] = [
  'https://microsoftonline.com/*',
  'https://live.com/*',
  'https://windows.net/*',
];

/** Konkrete Origins für browsingData (dort sind keine Wildcards erlaubt). */
export const KNOWN_APP_ORIGINS: readonly string[] = [
  'https://outlook.office.com',
  'https://outlook.office365.com',
  'https://outlook.cloud.microsoft',
  'https://admin.microsoft.com',
  'https://admin.cloud.microsoft',
  'https://m365.cloud.microsoft',
  'https://www.office.com',
  'https://portal.office.com',
  'https://entra.microsoft.com',
  'https://portal.azure.com',
  'https://login.microsoftonline.com',
];
