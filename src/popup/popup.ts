import {
  COLOR_HEX,
  COLOR_LABEL,
  START_PAGES,
  TAB_GROUP_COLORS,
  type Container,
  type ContainerColor,
  type PopupRequest,
  type PopupState,
  type Result,
} from '../shared/types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const EXTERNAL_IDP_ORIGINS = ['https://*/*'];
const START_KEY = 'popup.startPage';

let state: PopupState | null = null;
let editing: string | null = null;
let confirmDelete: string | null = null;
let newColor: ContainerColor = 'green';

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

function dot(color: ContainerColor): HTMLSpanElement {
  return h('span', { className: 'dot', style: `background:${COLOR_HEX[color]}` });
}

function swatches(selected: ContainerColor, onPick: (c: ContainerColor) => void): HTMLDivElement {
  const wrap = h('div', { className: 'swatches' });
  wrap.setAttribute('role', 'radiogroup');
  for (const c of TAB_GROUP_COLORS) {
    const b = h('button', { type: 'button', className: 'swatch', title: COLOR_LABEL[c], style: `background:${COLOR_HEX[c]}` });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(c === selected));
    b.setAttribute('aria-label', COLOR_LABEL[c]);
    b.addEventListener('click', () => {
      onPick(c);
      wrap.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s === b)));
    });
    wrap.append(b);
  }
  return wrap;
}

function startUrl(): string {
  return ($('startPage') as HTMLSelectElement).value || START_PAGES[0].url;
}

async function refresh(): Promise<void> {
  try {
    state = await call<PopupState>({ type: 'popup:state' });
    render();
  } catch (e) {
    showError(e);
  }
}

function render(): void {
  if (!state) return;
  renderCurrent(state);
  const list = $('list');
  list.replaceChildren(...state.containers.map((c) => (editing === c.id ? editRow(c) : row(c))));
  if (!state.containers.length) list.append(h('li', { className: 'hint' }, 'Noch keine Container.'));
  ($('externalIdp') as HTMLInputElement).checked = state.externalIdpEnabled;
}

function renderCurrent(s: PopupState): void {
  const box = $('current');
  const cur = s.current;
  const c = cur?.containerId ? s.containers.find((x) => x.id === cur.containerId) : undefined;
  const title = h('div', { className: 'row' });
  if (c) title.append(dot(c.color), h('strong', {}, c.name));
  else title.append(h('span', {}, 'Kein Container'));
  const children: Node[] = [h('div', { className: 'label' }, 'Aktueller Tab'), title];

  if (cur && /^https?:/.test(cur.url ?? '') && s.containers.length) {
    const sel = h('select', {});
    sel.append(h('option', { value: '' }, c ? 'In anderem Container öffnen …' : 'In Container öffnen …'));
    for (const x of s.containers) if (x.id !== c?.id) sel.append(h('option', { value: x.id }, x.name));
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      try {
        await call({ type: 'tab:reopenIn', tabId: cur.tabId, id: sel.value });
        window.close();
      } catch (e) {
        showError(e);
      }
    });
    children.push(h('div', { className: 'row', style: 'margin-top:6px' }, sel));
  }
  box.replaceChildren(...children);
}

function row(c: Container & { tabCount: number }): HTMLLIElement {
  const open = h('button', { className: 'primary', title: 'Neuen Tab in diesem Container öffnen' }, '+ Tab');
  open.addEventListener('click', async () => {
    try {
      await call({ type: 'container:openTab', id: c.id, url: startUrl() });
      window.close();
    } catch (e) {
      showError(e);
    }
  });

  const edit = h('button', { className: 'icon', title: 'Umbenennen / Farbe ändern' }, '✎');
  edit.addEventListener('click', () => {
    editing = c.id;
    confirmDelete = null;
    render();
  });

  const isConfirm = confirmDelete === c.id;
  const del = h(
    'button',
    { className: 'icon' + (isConfirm ? ' danger' : ''), title: 'Container löschen' },
    isConfirm ? 'Wirklich löschen?' : '🗑',
  );
  del.addEventListener('click', async () => {
    if (!isConfirm) {
      confirmDelete = c.id;
      render();
      return;
    }
    try {
      await call({ type: 'container:delete', id: c.id });
      confirmDelete = null;
      await refresh();
    } catch (e) {
      showError(e);
    }
  });

  const count = h('span', { className: 'count' }, c.tabCount === 1 ? '1 Tab' : `${c.tabCount} Tabs`);
  return h('li', {}, dot(c.color), h('span', { className: 'name', title: c.name }, c.name), count, open, edit, del);
}

function editRow(c: Container): HTMLLIElement {
  let color = c.color;
  const name = h('input', { type: 'text', value: c.name, maxLength: 40 });
  const save = h('button', { className: 'primary' }, 'Speichern');
  const cancel = h('button', {}, 'Abbrechen');
  const doSave = async () => {
    try {
      await call({ type: 'container:update', id: c.id, name: name.value, color });
      editing = null;
      showError(null);
      await refresh();
    } catch (e) {
      showError(e);
    }
  };
  save.addEventListener('click', doSave);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void doSave();
    if (e.key === 'Escape') cancel.click();
  });
  cancel.addEventListener('click', () => {
    editing = null;
    render();
  });
  queueMicrotask(() => name.focus());
  return h('li', { className: 'edit' }, name, swatches(color, (x) => (color = x)), save, cancel);
}

async function init(): Promise<void> {
  const sel = $('startPage') as HTMLSelectElement;
  for (const p of START_PAGES) sel.append(h('option', { value: p.url }, p.label));
  const stored = (await chrome.storage.local.get(START_KEY))[START_KEY];
  if (typeof stored === 'string' && START_PAGES.some((p) => p.url === stored)) sel.value = stored;
  sel.addEventListener('change', () => void chrome.storage.local.set({ [START_KEY]: sel.value }));

  $('newColor').replaceWith(
    Object.assign(swatches(newColor, (c) => (newColor = c)), { id: 'newColor' }),
  );

  $('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('newName') as HTMLInputElement;
    try {
      await call({ type: 'container:create', name: input.value, color: newColor });
      input.value = '';
      showError(null);
      await refresh();
    } catch (err) {
      showError(err);
    }
  });

  $('externalIdp').addEventListener('change', async (e) => {
    const box = e.target as HTMLInputElement;
    try {
      if (box.checked) box.checked = await chrome.permissions.request({ origins: EXTERNAL_IDP_ORIGINS });
      else await chrome.permissions.remove({ origins: EXTERNAL_IDP_ORIGINS });
    } catch (err) {
      showError(err);
    }
  });

  $('clearSw').addEventListener('click', async (e) => {
    const b = e.target as HTMLButtonElement;
    try {
      await call({ type: 'maintenance:clearServiceWorkers' });
      b.textContent = 'Entfernt ✓';
    } catch (err) {
      showError(err);
    }
  });

  await refresh();
}

void init();
