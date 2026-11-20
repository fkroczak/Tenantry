/**
 * Tenantry-Popup (Entwurf „Graphite“): Suche, Filter, Favoriten, A–Z-Liste
 * mit aufklappender Trefferzeile; Unteransichten für Update, Sicherung,
 * Diagnose und Mehr. Farbschema automatisch oder per Knopf.
 */
import {
  COLOR_HEX,
  COLOR_LABEL,
  START_PAGES,
  TAB_GROUP_COLORS,
  type BackupResult,
  type Container,
  type ContainerColor,
  type DiagStatus,
  type PopupRequest,
  type PopupState,
  type Result,
  type UpdateInfo,
} from '../shared/types';

type Item = Container & { tabCount: number };
type Filter = 'all' | 'open' | 'fav';
type Theme = 'auto' | 'light' | 'dark';
type View = 'main' | 'update' | 'backup' | 'diag' | 'more';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const EXTERNAL_IDP_ORIGINS = ['https://*/*'];
const START_KEY = 'popup.startPage';
const THEME_KEY = 'tenantry.theme';
const COLLATOR = new Intl.Collator('de', { sensitivity: 'base' });

/** Schnellzugriffe in der aufgeklappten Zeile (zusätzlich zu „+ Tab“). */
const QUICK_APPS = [
  { label: 'Admin', url: 'https://admin.microsoft.com/' },
  { label: 'Outlook', url: 'https://outlook.office.com/mail/' },
  { label: 'Entra', url: 'https://entra.microsoft.com/' },
] as const;

const ICONS = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
};

const ui = {
  state: null as PopupState | null,
  query: '',
  filter: 'all' as Filter,
  /** Aufgeklappte Zeile: "<abschnitt>:<containerId>" */
  openKey: null as string | null,
  editing: null as string | null,
  confirmDelete: null as string | null,
  newColor: 'green' as ContainerColor,
  view: 'main' as View,
};

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

async function call<T>(msg: PopupRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as Result<T> | undefined;
  if (!res) throw new Error('Keine Antwort vom Hintergrunddienst.');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function showError(e: unknown): void {
  const el = $('error');
  el.textContent = e ? (e instanceof Error ? e.message : String(e)) : '';
  el.hidden = !e;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> & { style?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(el, rest);
  if (style) el.setAttribute('style', style);
  el.append(...children);
  return el;
}

function icon(svg: string): HTMLSpanElement {
  const s = h('span', { style: 'display:contents' });
  s.innerHTML = svg; // nur feste Konstanten aus ICONS
  return s;
}

function dot(color: ContainerColor): HTMLSpanElement {
  return h('span', { className: 'dot', style: `background:${COLOR_HEX[color]}` });
}

function saveFile(content: string, name: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

/** Name mit hervorgehobenem Suchtreffer. */
function highlighted(name: string, q: string): (Node | string)[] {
  if (!q) return [name];
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [name];
  return [name.slice(0, i), h('mark', {}, name.slice(i, i + q.length)), name.slice(i + q.length)];
}

function startUrl(): string {
  return ($('startPage') as HTMLSelectElement).value || START_PAGES[0].url;
}

// ---------------------------------------------------------------------------
// Farbschema
// ---------------------------------------------------------------------------

function getTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function setTheme(t: Theme): void {
  try {
    if (t === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    /* nur für diese Sitzung */
  }
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  renderTheme();
}

function renderTheme(): void {
  const t = getTheme();
  const label = { auto: 'Darstellung: wie Windows', light: 'Darstellung: hell', dark: 'Darstellung: dunkel' }[t];
  const btn = $('themeBtn');
  btn.replaceChildren(icon(ICONS[t]));
  btn.title = `${label} (klicken zum Wechseln)`;
  btn.setAttribute('aria-label', label);
  ($('themeSelect') as HTMLSelectElement).value = t;
}

// ---------------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------------

function showView(v: View): void {
  ui.view = v;
  const map: Record<View, string> = { main: 'viewMain', update: 'viewUpdate', backup: 'viewBackup', diag: 'viewDiag', more: 'viewMore' };
  for (const [k, id] of Object.entries(map)) $(id).hidden = k !== v;
  const nav: Partial<Record<View, string>> = { backup: 'navBackup', diag: 'navDiag', more: 'navMore' };
  for (const [k, id] of Object.entries(nav)) {
    if (k === v) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  showError(null);
  if (v === 'main') $('search').focus();
}

// ---------------------------------------------------------------------------
// Container-Liste
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    ui.state = await call<PopupState>({ type: 'popup:state' });
    render();
  } catch (e) {
    showError(e);
  }
}

function sorted(list: Item[]): Item[] {
  return [...list].sort((a, b) => COLLATOR.compare(a.name, b.name));
}

interface Row {
  key: string;
  c: Item;
  letter: string;
}

/** Abschnitte und Zeilen gemäß Suche und Filter. */
function computeRows(): { sections: { title: string; rows: Row[] }[]; hits: number } {
  const all = sorted(ui.state?.containers ?? []);
  const q = ui.query.trim().toLowerCase();
  let base = all;
  if (ui.filter === 'open') base = base.filter((c) => c.tabCount > 0);
  if (ui.filter === 'fav') base = base.filter((c) => c.favorite);
  if (q) {
    // Rang: Namensanfang < Wortanfang < irgendwo; innerhalb gleich alphabetisch.
    const rank = (name: string) => {
      const n = name.toLowerCase();
      if (n.startsWith(q)) return 0;
      if (n.split(/[\s\-_.&/]+/).some((w) => w.startsWith(q))) return 1;
      return n.includes(q) ? 2 : 3;
    };
    base = base.filter((c) => rank(c.name) < 3).sort((a, b) => rank(a.name) - rank(b.name) || COLLATOR.compare(a.name, b.name));
    return { sections: [{ title: '', rows: base.map((c) => ({ key: `r:${c.id}`, c, letter: '' })) }], hits: base.length };
  }

  const withLetters = (prefix: string, list: Item[]): Row[] => {
    let last = '';
    return list.map((c) => {
      const l = c.name.charAt(0).toLocaleUpperCase('de');
      const letter = l !== last ? l : '';
      last = l;
      return { key: `${prefix}:${c.id}`, c, letter };
    });
  };

  if (q || ui.filter !== 'all') {
    return { sections: [{ title: '', rows: withLetters('r', base) }], hits: base.length };
  }
  const favs = base.filter((c) => c.favorite);
  const sections = [];
  if (favs.length) sections.push({ title: '★ Favoriten', rows: favs.map((c) => ({ key: `f:${c.id}`, c, letter: '' })) });
  sections.push({ title: favs.length ? 'Alle · A–Z' : '', rows: withLetters('a', base) });
  return { sections, hits: base.length };
}

function navigableKeys(): string[] {
  return computeRows().sections.flatMap((s) => s.rows.map((r) => r.key));
}

function render(): void {
  const s = ui.state;
  if (!s) return;

  // Kopf: aktueller Container
  const chip = $('currentChip');
  const cur = s.current?.containerId ? s.containers.find((c) => c.id === s.current!.containerId) : undefined;
  chip.hidden = false;
  chip.replaceChildren(...(cur ? [dot(cur.color), cur.name] : ['Kein Container']));
  chip.title = cur ? `Dieser Tab läuft im Container „${cur.name}“` : 'Dieser Tab gehört zu keinem Container';

  // Suche
  ($('search') as HTMLInputElement).placeholder = `${s.containers.length} ${s.containers.length === 1 ? 'Container' : 'Container'} durchsuchen`;
  $('clearSearch').hidden = !ui.query;

  // Filter
  const counts = {
    all: s.containers.length,
    open: s.containers.filter((c) => c.tabCount > 0).length,
    fav: s.containers.filter((c) => c.favorite).length,
  };
  const labels: Record<Filter, string> = { all: `Alle ${counts.all}`, open: `Offen ${counts.open}`, fav: `★ Favoriten ${counts.fav}` };
  $('filters').replaceChildren(
    ...(['all', 'open', 'fav'] as Filter[]).map((f) => {
      const b = h('button', { type: 'button' }, labels[f]);
      b.setAttribute('aria-pressed', String(ui.filter === f));
      b.addEventListener('click', () => {
        ui.filter = f;
        ui.openKey = null;
        render();
      });
      return b;
    }),
  );

  // Liste
  const { sections, hits } = computeRows();
  const hitCount = $('hitCount');
  hitCount.hidden = !ui.query;
  hitCount.textContent = hits === 1 ? '1 Treffer' : `${hits} Treffer`;

  const keys = sections.flatMap((x) => x.rows.map((r) => r.key));
  if (ui.openKey && !keys.includes(ui.openKey)) ui.openKey = null;
  if (ui.query && !ui.openKey && keys.length) ui.openKey = keys[0] ?? null;

  const list = $('list');
  const nodes: Node[] = [];
  for (const sec of sections) {
    if (sec.title) nodes.push(h('div', { className: 'section' }, sec.title));
    for (const r of sec.rows) nodes.push(row(r, s));
  }
  const q = ui.query.trim();
  if (q && !s.containers.some((c) => c.name.toLowerCase() === q.toLowerCase())) {
    const b = h('button', { type: 'button', className: 'create-hit' }, icon(ICONS.plus), `Container „${q}“ anlegen`);
    b.addEventListener('click', () => openCreate(q));
    nodes.push(b);
  }
  if (!nodes.length) {
    nodes.push(
      h('div', { className: 'empty' }, ui.filter === 'fav' ? 'Noch keine Favoriten – ★ an einem Container setzen.' : ui.filter === 'open' ? 'Kein Container hat offene Tabs.' : 'Noch keine Container.'),
    );
  }
  list.replaceChildren(...nodes);
  list.querySelector('.item.open')?.scrollIntoView({ block: 'nearest' });
}

function row(r: Row, s: PopupState): HTMLDivElement {
  const c = r.c;
  const open = ui.openKey === r.key;
  const isCurrent = s.current?.containerId === c.id;

  const star = h('button', { type: 'button', className: 'star' + (c.favorite ? ' on' : ''), title: c.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten' }, icon(ICONS.star));
  star.setAttribute('aria-label', c.favorite ? `${c.name} aus Favoriten entfernen` : `${c.name} zu Favoriten`);
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await call({ type: 'container:update', id: c.id, favorite: !c.favorite });
      await refresh();
    } catch (err) {
      showError(err);
    }
  });

  const line = h(
    'div',
    { className: 'line' },
    h('span', { className: 'letter' }, r.letter),
    dot(c.color),
    h('span', { className: 'name', title: c.name }, ...highlighted(c.name, ui.query.trim())),
    h('span', { className: 'count', title: `${c.tabCount} Tabs offen` }, c.tabCount ? String(c.tabCount) : ''),
    star,
  );
  line.addEventListener('click', () => {
    ui.openKey = open ? null : r.key;
    ui.editing = null;
    ui.confirmDelete = null;
    render();
  });

  const el = h('div', { className: 'item' + (open ? ' open' : '') + (isCurrent ? ' current' : '') }, line);
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', String(open));
  if (open) el.append(ui.editing === c.id ? editForm(c) : actions(c, s));
  return el;
}

async function openTab(cid: string, url: string): Promise<void> {
  try {
    await call({ type: 'container:openTab', id: cid, url });
    window.close();
  } catch (e) {
    showError(e);
  }
}

function actions(c: Item, s: PopupState): HTMLDivElement {
  const plus = h('button', { type: 'button', className: 'primary', title: `Neuer Tab: ${START_PAGES.find((p) => p.url === startUrl())?.label ?? ''}` }, '+ Tab');
  plus.addEventListener('click', () => void openTab(c.id, startUrl()));
  const apps = h('div', { className: 'apps' }, plus);
  for (const a of QUICK_APPS) {
    const b = h('button', { type: 'button', title: `${a.label} in „${c.name}“ öffnen` }, a.label);
    b.addEventListener('click', () => void openTab(c.id, a.url));
    apps.append(b);
  }

  const tools = h('div', { className: 'tools' });
  const cur = s.current;
  if (cur && /^https?:/.test(cur.url ?? '') && cur.containerId !== c.id) {
    const move = h('button', { type: 'button', title: 'Aktuelle Seite in diesem Container neu öffnen' }, 'Aktuellen Tab hierher');
    move.addEventListener('click', async () => {
      try {
        await call({ type: 'tab:reopenIn', tabId: cur.tabId, id: c.id });
        window.close();
      } catch (e) {
        showError(e);
      }
    });
    tools.append(move);
  }
  const edit = h('button', { type: 'button' }, 'Umbenennen / Farbe');
  edit.addEventListener('click', () => {
    ui.editing = c.id;
    render();
  });
  const confirm = ui.confirmDelete === c.id;
  const del = h('button', { type: 'button', className: 'del' + (confirm ? ' confirm' : '') }, confirm ? 'Wirklich löschen?' : 'Löschen');
  del.addEventListener('click', async () => {
    if (!confirm) {
      ui.confirmDelete = c.id;
      render();
      return;
    }
    try {
      await call({ type: 'container:delete', id: c.id });
      ui.confirmDelete = null;
      ui.openKey = null;
      await refresh();
    } catch (e) {
      showError(e);
    }
  });
  tools.append(edit, del);
  return h('div', { className: 'actions' }, apps, tools);
}

function swatches(selected: ContainerColor, onPick: (c: ContainerColor) => void): HTMLDivElement {
  const wrap = h('div', { className: 'swatches' });
  wrap.setAttribute('role', 'radiogroup');
  wrap.setAttribute('aria-label', 'Farbe');
  for (const col of TAB_GROUP_COLORS) {
    const b = h('button', { type: 'button', className: 'swatch', title: COLOR_LABEL[col], style: `background:${COLOR_HEX[col]}` });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(col === selected));
    b.setAttribute('aria-label', COLOR_LABEL[col]);
    b.addEventListener('click', () => {
      onPick(col);
      wrap.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    wrap.append(b);
  }
  return wrap;
}

function editForm(c: Item): HTMLFormElement {
  let color = c.color;
  const name = h('input', { type: 'text', value: c.name, maxLength: 40, required: true });
  name.setAttribute('aria-label', 'Name');
  const cancel = h('button', { type: 'button', className: 'ghost' }, 'Abbrechen');
  cancel.addEventListener('click', () => {
    ui.editing = null;
    render();
  });
  const form = h(
    'form',
    { className: 'actions edit' },
    name,
    swatches(color, (x) => (color = x)),
    h('div', { className: 'row end' }, cancel, h('button', { type: 'submit', className: 'primary' }, 'Speichern')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call({ type: 'container:update', id: c.id, name: name.value, color });
      ui.editing = null;
      showError(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  });
  queueMicrotask(() => name.select());
  return form;
}

// ---------------------------------------------------------------------------
// Neuer Container
// ---------------------------------------------------------------------------

function openCreate(prefill = ''): void {
  const form = $('createForm');
  form.hidden = false;
  const input = $('newName') as HTMLInputElement;
  input.value = prefill;
  // Noch nicht verwendete Farbe vorschlagen.
  const used = new Set(ui.state?.containers.map((c) => c.color));
  ui.newColor = TAB_GROUP_COLORS.find((c) => !used.has(c)) ?? 'blue';
  $('newColor').replaceWith(Object.assign(swatches(ui.newColor, (c) => (ui.newColor = c)), { id: 'newColor' }));
  input.focus();
}

function closeCreate(): void {
  $('createForm').hidden = true;
}

// ---------------------------------------------------------------------------
// Tastatur
// ---------------------------------------------------------------------------

function onKey(e: KeyboardEvent): void {
  if (ui.view !== 'main') {
    if (e.key === 'Escape') {
      e.preventDefault();
      showView('main');
    }
    return;
  }
  const target = e.target as HTMLElement;
  const inSearch = target.id === 'search';
  const inOtherField = !inSearch && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);

  if (e.key === 'Escape') {
    e.preventDefault();
    if (!$('createForm').hidden) closeCreate();
    else if (ui.editing) ui.editing = null;
    else if (ui.query) {
      ui.query = '';
      ($('search') as HTMLInputElement).value = '';
      ui.openKey = null;
    } else if (ui.openKey) ui.openKey = null;
    else window.close();
    render();
    $('search').focus();
    return;
  }
  if (inOtherField) return;
  if (e.key === '/' && !inSearch) {
    e.preventDefault();
    $('search').focus();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const keys = navigableKeys();
    if (!keys.length) return;
    const i = ui.openKey ? keys.indexOf(ui.openKey) : -1;
    const next = e.key === 'ArrowDown' ? Math.min(keys.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
    ui.openKey = keys[next] ?? null;
    ui.editing = null;
    ui.confirmDelete = null;
    render();
    return;
  }
  if (e.key === 'Enter' && (inSearch || target === document.body)) {
    e.preventDefault();
    const cid = ui.openKey?.split(':')[1];
    if (cid) void openTab(cid, startUrl());
    else if (ui.query.trim()) openCreate(ui.query.trim());
  }
}

// ---------------------------------------------------------------------------
// Update, Sicherung, Diagnose, Mehr
// ---------------------------------------------------------------------------

function renderUpdate(u: UpdateInfo): void {
  const chip = $('updateChip');
  chip.hidden = !u.available;
  chip.textContent = `${u.latest} ↑`;
  chip.title = `Update auf v${u.latest} verfügbar`;
  $('updateTitle').textContent = `Update verfügbar: v${u.current} → v${u.latest}`;
  ($('updatePage') as HTMLAnchorElement).href = u.pageUrl;
  const zip = $('updateZip') as HTMLAnchorElement;
  zip.hidden = !u.zipUrl;
  if (u.zipUrl) zip.href = u.zipUrl;
  const when = u.checkedAt ? new Date(u.checkedAt).toLocaleString() : 'nie';
  $('updateInfo').textContent = u.error
    ? `Prüfung fehlgeschlagen: ${u.error}`
    : u.available
      ? `v${u.latest} verfügbar`
      : `Aktuell (geprüft ${when})`;
}

function renderBackup(last: number | null): void {
  $('backupDot').hidden = last !== null;
  $('backupInfo').textContent = last ? `Letzte Sicherung: ${new Date(last).toLocaleString()}` : 'Noch keine Sicherung gespeichert.';
}

function renderDiag(s: DiagStatus): void {
  const toggle = $('diagToggle');
  toggle.textContent = s.recording ? 'Aufzeichnung stoppen' : 'Aufzeichnung starten';
  toggle.className = s.recording ? 'danger' : 'primary';
  $('diagDot').hidden = !s.recording;
  const since = s.since ? new Date(s.since).toLocaleTimeString() : null;
  $('diagInfo').textContent = `${s.count} Einträge` + (s.recording && since ? ` · läuft seit ${since} (stoppt nach 30 Min.)` : '');
  ($('diagExport') as HTMLButtonElement).disabled = !s.count;
}

function bind(id: string, fn: () => Promise<unknown> | void): void {
  $(id).addEventListener('click', async () => {
    try {
      showError(null);
      await fn();
    } catch (e) {
      showError(e);
    }
  });
}

async function init(): Promise<void> {
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.back')) {
    b.replaceChildren(icon(ICONS.back));
    b.addEventListener('click', () => showView('main'));
  }
  renderTheme();
  $('themeBtn').addEventListener('click', () => {
    const order: Theme[] = ['auto', 'light', 'dark'];
    setTheme(order[(order.indexOf(getTheme()) + 1) % order.length] ?? 'auto');
  });
  $('themeSelect').addEventListener('change', (e) => setTheme((e.target as HTMLSelectElement).value as Theme));

  // Startseite
  const sel = $('startPage') as HTMLSelectElement;
  for (const p of START_PAGES) sel.append(h('option', { value: p.url }, p.label));
  const stored = (await chrome.storage.local.get(START_KEY))[START_KEY];
  if (typeof stored === 'string' && START_PAGES.some((p) => p.url === stored)) sel.value = stored;
  sel.addEventListener('change', () => void chrome.storage.local.set({ [START_KEY]: sel.value }));

  // Suche
  const search = $('search') as HTMLInputElement;
  search.addEventListener('input', () => {
    ui.query = search.value;
    ui.openKey = null;
    render();
  });
  bind('clearSearch', () => {
    search.value = '';
    ui.query = '';
    ui.openKey = null;
    render();
    search.focus();
  });
  document.addEventListener('keydown', onKey);

  // Neuer Container
  $('addBtn').addEventListener('click', () => ($('createForm').hidden ? openCreate(ui.query.trim()) : closeCreate()));
  $('createCancel').addEventListener('click', closeCreate);
  $('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const c = await call<Container>({ type: 'container:create', name: ($('newName') as HTMLInputElement).value, color: ui.newColor });
      closeCreate();
      search.value = '';
      ui.query = '';
      ui.filter = 'all';
      ui.openKey = `a:${c.id}`;
      showError(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  });

  // Navigation
  const nav = (v: View) => () => showView(ui.view === v ? 'main' : v);
  $('navBackup').addEventListener('click', nav('backup'));
  $('navDiag').addEventListener('click', nav('diag'));
  $('navMore').addEventListener('click', nav('more'));
  $('updateChip').addEventListener('click', () => showView('update'));

  // Update
  bind('updateCheck', async () => {
    $('updateInfo').textContent = 'Prüfe …';
    renderUpdate(await call<UpdateInfo>({ type: 'update:check' }));
  });
  bind('updateReload', async () => {
    await call({ type: 'update:reload' });
    window.close();
  });

  // Sicherung
  bind('backupExport', async () => {
    const withCookies = ($('backupCookies') as HTMLInputElement).checked;
    const json = await call<string>({ type: 'backup:export', includeCookies: withCookies });
    saveFile(json, `tenantry-sicherung-${withCookies ? 'mit-anmeldungen-' : ''}${stamp()}.json`);
    renderBackup(await call<number | null>({ type: 'backup:status' }));
  });
  const file = $('backupFile') as HTMLInputElement;
  $('backupImport').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const r = await call<BackupResult>({ type: 'backup:import', json: await f.text() });
      $('backupInfo').textContent =
        `Wiederhergestellt: ${r.added} neue, ${r.updated} aktualisierte Container` + (r.cookies ? `, ${r.cookies} Anmelde-Cookies.` : '.');
      showError(null);
      await refresh();
    } catch (e) {
      showError(e);
    }
  });

  // Diagnose
  bind('diagToggle', async () => {
    const cur = await call<DiagStatus>({ type: 'diag:status' });
    renderDiag(await call<DiagStatus>({ type: cur.recording ? 'diag:stop' : 'diag:start' }));
  });
  bind('diagClear', async () => renderDiag(await call<DiagStatus>({ type: 'diag:clear' })));
  bind('diagExport', async () => saveFile(await call<string>({ type: 'diag:export' }), `tenantry-diagnose-${stamp()}.json`));

  // Mehr
  $('externalIdp').addEventListener('change', async (e) => {
    const box = e.target as HTMLInputElement;
    try {
      if (box.checked) box.checked = await chrome.permissions.request({ origins: EXTERNAL_IDP_ORIGINS });
      else await chrome.permissions.remove({ origins: EXTERNAL_IDP_ORIGINS });
    } catch (err) {
      showError(err);
    }
  });
  bind('clearSw', async () => {
    await call({ type: 'maintenance:clearServiceWorkers' });
    $('clearSw').textContent = 'Entfernt ✓';
  });

  await refresh();
  ($('externalIdp') as HTMLInputElement).checked = !!ui.state?.externalIdpEnabled;
  search.focus();

  // Status im Hintergrund nachladen
  void call<UpdateInfo>({ type: 'update:status' }).then(renderUpdate, () => undefined);
  void call<number | null>({ type: 'backup:status' }).then(renderBackup, () => undefined);
  const pollDiag = () => void call<DiagStatus>({ type: 'diag:status' }).then(renderDiag, () => undefined);
  pollDiag();
  setInterval(pollDiag, 1500);
}

void init();
