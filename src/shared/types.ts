import type { CookieTuple } from './payload';

export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;
export type ContainerColor = (typeof TAB_GROUP_COLORS)[number];

/** Anzeigefarben (entsprechen grob den Chrome-Tab-Group-Farben). */
export const COLOR_HEX: Record<ContainerColor, string> = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

export const COLOR_LABEL: Record<ContainerColor, string> = {
  grey: 'Grau',
  blue: 'Blau',
  red: 'Rot',
  yellow: 'Gelb',
  green: 'Grün',
  pink: 'Pink',
  purple: 'Lila',
  cyan: 'Türkis',
  orange: 'Orange',
};

export interface Container {
  id: string;
  name: string;
  color: ContainerColor;
  createdAt: number;
}

export const START_PAGES = [
  { label: 'Microsoft 365 Admin Center', url: 'https://admin.microsoft.com/' },
  { label: 'Outlook Web', url: 'https://outlook.office.com/mail/' },
  { label: 'Microsoft 365 (Start)', url: 'https://www.office.com/' },
  { label: 'Entra Admin Center', url: 'https://entra.microsoft.com/' },
  { label: 'Azure-Portal', url: 'https://portal.azure.com/' },
] as const;

// ---- Nachrichten -----------------------------------------------------------

export interface PopupState {
  containers: (Container & { tabCount: number })[];
  current: { tabId: number; containerId: string | null; url: string | null } | null;
  externalIdpEnabled: boolean;
}

export type PopupRequest =
  | { type: 'popup:state' }
  | { type: 'container:create'; name: string; color: ContainerColor }
  | { type: 'container:update'; id: string; name?: string; color?: ContainerColor }
  | { type: 'container:delete'; id: string }
  | { type: 'container:openTab'; id: string; url: string }
  | { type: 'tab:reopenIn'; tabId: number; id: string }
  | { type: 'maintenance:clearServiceWorkers' };

export type ContentRequest =
  | { type: 'content:hello' }
  | { type: 'content:setCookie'; cookie: string };

export interface HelloResponse {
  cid: string | null;
  cookies: CookieTuple[];
}

/** Background -> Content (Bridge) */
export interface CookiePush {
  type: 'bg:cookies';
  cid: string;
  cookies: CookieTuple[];
}

export type Result<T = undefined> = { ok: true; data: T } | { ok: false; error: string };
