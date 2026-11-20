/**
 * End-to-End-Test: lädt dist/ als entpackte Erweiterung in Chromium und leitet
 * die Microsoft-Hostnamen per --host-resolver-rules auf einen lokalen
 * HTTPS-Server um. Prüft Cookie-, Storage- und Tab-Isolierung zweier Container.
 *
 *   npm run build && node e2e/run.mjs
 *
 * Voraussetzungen: Playwright + Chromium, openssl.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from './server.mjs';

// Playwright wird nicht als Projekt-Abhängigkeit installiert (global vorhanden oder `npm i -g playwright`).
const { chromium } = createRequire(import.meta.url)('playwright');

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const work = mkdtempSync(join(tmpdir(), 'tenantry-e2e-'));
const PORT = 8443;

execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=tenantry-e2e',
  '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem'),
  '-addext', 'subjectAltName=DNS:*.microsoftonline.com,DNS:login.microsoftonline.com,DNS:*.office.com,DNS:*.microsoft.com,DNS:*.sharepoint.com',
], { stdio: 'ignore' });
const server = await startServer({ key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')), port: PORT });

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✔' : '✘'} ${name}${cond ? '' : '  -> ' + detail}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--host-resolver-rules=MAP * 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    '--no-proxy-server',
  ],
});

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  check('Feste Erweiterungs-ID aus manifest.key', extId === 'lilkabchipnpplblekhiknflngomlmpk', extId);
  await sleep(500);

  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/popup.html`);
  const send = (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
  const st = await send({ type: 'popup:state' });
  check('Zwei Standard-Container angelegt', st.ok && st.data.containers.length === 2, JSON.stringify(st));
  const [A, B] = st.data.containers;

  const pageOf = async (tabId) => {
    for (let i = 0; i < 50; i++) {
      // Tab-ID -> Page: über die URL zuordnen
      await sleep(100);
      const tab = await sw.evaluate((t) => chrome.tabs.get(t), tabId);
      const p = ctx.pages().find((pg) => pg.url() === tab.url && !pg.__claimed);
      if (p && tab.status === 'complete') {
        p.__claimed = true;
        return p;
      }
    }
    const tab = await sw.evaluate((t) => chrome.tabs.get(t), tabId);
    throw new Error('Page für Tab nicht gefunden: ' + tabId + ' ' + JSON.stringify(tab) + ' pages=' + (await Promise.all(ctx.pages().map((p) => p.evaluate(() => location.href + ' ' + document.body?.innerText.slice(0, 200)).catch((e) => 'ERR ' + e.message)))).join(' || '));
  };

  // Login in Container A und B
  const tabA = (await send({ type: 'container:openTab', id: A.id, url: 'https://login.microsoftonline.com/login?user=alice' })).data;
  const pA = await pageOf(tabA);
  const tabB = (await send({ type: 'container:openTab', id: B.id, url: 'https://login.microsoftonline.com/login?user=bob' })).data;
  const pB = await pageOf(tabB);
  await sleep(500);

  // Navigation, die Tenantry evtl. wiederholt (veraltete Cookies nach einem 302):
  // Playwright meldet die abgebrochene erste Navigation als ERR_ABORTED.
  const gotoSettled = async (p, url) => {
    await p.goto(url).catch((e) => {
      if (!/ERR_ABORTED|interrupted by another navigation/.test(String(e))) throw e;
    });
    await p.waitForLoadState('load');
  };

  // Redirect mit Set-Cookie auf dem 302
  await gotoSettled(pA, 'https://outlook.office.com/redirect?user=alice');
  await gotoSettled(pB, 'https://outlook.office.com/redirect?user=bob');
  await sleep(500);

  // 1) Server sieht pro Container nur die eigenen Cookies
  await pA.goto('https://login.microsoftonline.com/echo');
  await pB.goto('https://login.microsoftonline.com/echo');
  const cA = await pA.textContent('#cookie');
  const cB = await pB.textContent('#cookie');
  check('A: Login-Cookies von A gesendet', /ESTSAUTH=alice/.test(cA) && /buid=alice-buid/.test(cA), cA);
  check('B: Login-Cookies von B gesendet', /ESTSAUTH=bob/.test(cB) && /buid=bob-buid/.test(cB), cB);
  check('Keine Vermischung A/B', !/bob/.test(cA) && !/alice/.test(cB), `${cA} | ${cB}`);

  await pA.goto('https://outlook.office.com/owa');
  await pB.goto('https://outlook.office.com/owa');
  const oA = await pA.textContent('#cookie');
  const oB = await pB.textContent('#cookie');
  check('Domain-Cookie aus 302 (A) bei outlook.office.com', oA.trim() === 'OpenIdConnect.token=alice-oidc', oA);
  check('Domain-Cookie aus 302 (B) bei outlook.office.com', oB.trim() === 'OpenIdConnect.token=bob-oidc', oB);

  // SharePoint: form_post -> 302 mit FedAuth -> Zielseite muss FedAuth sofort mitsenden
  const spWait = async (p) => {
    await p.waitForURL(/_layouts\/15\/online\/AdminHome\.aspx/, { timeout: 10_000 }).catch(() => undefined);
    await p.waitForSelector('#sp', { timeout: 10_000 }).catch(() => undefined);
    return (await p.textContent('#sp').catch(() => null)) ?? (await p.content());
  };
  const diagOn = await send({ type: 'diag:start' });
  check('Diagnose: Aufzeichnung startet', diagOn.ok && diagOn.data.recording === true, JSON.stringify(diagOn));
  await gotoSettled(pA, 'https://contoso-admin.sharepoint.com/_layouts/15/online/AdminHome.aspx');
  const sA = await spWait(pA);
  check('SharePoint (A): Anmeldung per form_post + 302 klappt', /SP-OK alice-fedauth/.test(sA), sA);
  await sleep(300);
  await send({ type: 'diag:stop' });
  const diagJson = (await send({ type: 'diag:export' })).data;
  const diagDoc = JSON.parse(diagJson);
  const kinds = new Set(diagDoc.entries.map((e) => e.kind));
  check(
    'Diagnose: Requests, Antworten und Regel-Updates aufgezeichnet',
    ['req', 'send', 'resp', 'dnr:sync', 'jar:fromResponse'].every((k) => kinds.has(k)),
    [...kinds].join(','),
  );
  check(
    'Diagnose: Set-Cookie FedAuth erfasst (ohne Wert)',
    diagDoc.entries.some((e) => e.kind === 'resp' && (e.setCookies ?? []).some((c) => c.startsWith('FedAuth='))),
    '',
  );
  check('Diagnose: keine Cookie-Werte im Export', !/alice-fedauth|alice-oidc/.test(diagJson), diagJson.slice(0, 400));
  await send({ type: 'diag:clear' });
  await gotoSettled(pB, 'https://fabrikam-admin.sharepoint.com/_layouts/15/online/AdminHome.aspx');
  const sB = await spWait(pB);
  check('SharePoint (B): Anmeldung per form_post + 302 klappt', /SP-OK bob-fedauth/.test(sB), sB);
  await pA.goto('https://outlook.office.com/owa');
  await pB.goto('https://outlook.office.com/owa');

  // 2) fetch/XHR aus der Seite
  const fA = await pA.evaluate(() => fetch('/api/whoami', { credentials: 'include' }).then((r) => r.json()));
  check('fetch() in A sendet Container-Cookies', fA.cookie === 'OpenIdConnect.token=alice-oidc', JSON.stringify(fA));

  // 3) document.cookie (HttpOnly unsichtbar, JS-Cookie sichtbar, Schreiben)
  await pA.goto('https://login.microsoftonline.com/echo');
  await pB.goto('https://login.microsoftonline.com/echo');
  const dA = await pA.evaluate(() => document.cookie);
  const dB = await pB.evaluate(() => document.cookie);
  check('document.cookie A zeigt nur A (ohne HttpOnly)', /jsvisible=alice-js/.test(dA) && !/ESTSAUTH/.test(dA) && !/bob/.test(dA), dA);
  check('document.cookie B zeigt nur B', /jsvisible=bob-js/.test(dB) && !/alice/.test(dB), dB);
  await pA.evaluate(() => (document.cookie = 'fromjs=A1; path=/; secure'));
  check('document.cookie Schreiben sofort sichtbar', /fromjs=A1/.test(await pA.evaluate(() => document.cookie)));
  await sleep(400);
  await pA.goto('https://login.microsoftonline.com/echo');
  check('JS-Cookie geht an den Server (A)', /fromjs=A1/.test(await pA.textContent('#cookie')));
  await pB.reload();
  check('JS-Cookie nicht in B', !/fromjs/.test(await pB.textContent('#cookie')));
  check('Server-Timing-Kontext beim Laden verfügbar', /fromjs=A1/.test(await pA.evaluate(() => document.cookie)));

  // 4) localStorage / sessionStorage / IndexedDB
  await pA.evaluate(() => { localStorage.setItem('msal.token', 'tokenA'); sessionStorage.s = 'sA'; });
  await pB.evaluate(() => { localStorage.setItem('msal.token', 'tokenB'); });
  const lA = await pA.evaluate(() => [localStorage.getItem('msal.token'), localStorage.length, Object.keys(localStorage).join(), sessionStorage.s]);
  const lB = await pB.evaluate(() => [localStorage.getItem('msal.token'), localStorage.length, 'msal.token' in localStorage]);
  check('localStorage A isoliert', lA[0] === 'tokenA' && lA[1] === 1 && lA[2] === 'msal.token' && lA[3] === 'sA', JSON.stringify(lA));
  check('localStorage B isoliert', lB[0] === 'tokenB' && lB[1] === 1 && lB[2] === true, JSON.stringify(lB));
  const idb = await pA.evaluate(
    () => new Promise((res) => {
      const r = indexedDB.open('owa-cache', 1);
      r.onsuccess = async () => res([r.result.name, (await indexedDB.databases()).map((d) => d.name)]);
      r.onerror = () => res(['err']);
    }),
  );
  check('IndexedDB-Namen transparent', idb[0] === 'owa-cache' && idb[1].join() === 'owa-cache', JSON.stringify(idb));

  // 5) Tab ohne Container sieht nichts
  // Eigenes Fenster, damit Chrome den Tab nicht in eine bestehende Gruppe einsortiert.
  const [plain] = await Promise.all([
    ctx.waitForEvent('page'),
    sw.evaluate(() => chrome.windows.create({ url: 'https://login.microsoftonline.com/echo' })),
  ]);
  await plain.waitForLoadState();
  const cPlain = await plain.textContent('#cookie');
  check('Tab ohne Container: keine Container-Cookies (native Kopien entfernt)', !/alice|bob/.test(cPlain), cPlain);
  const lPlain = await plain.evaluate(() => localStorage.getItem('msal.token'));
  check('Tab ohne Container: kein Container-localStorage', lPlain === null, String(lPlain));
  const native = await sw.evaluate(() => chrome.cookies.getAll({}).then((l) => l.map((c) => `${c.name}@${c.domain}`)));
  check('Nativer Cookie-Speicher frei von Container-Cookies', !native.some((n) => /ESTSAUTH|buid|OpenIdConnect|FedAuth|rtFa/.test(n)), native.join());

  // 6) window.open erbt den Container
  const [popup] = await Promise.all([
    ctx.waitForEvent('page'),
    pA.evaluate(() => window.open('https://login.microsoftonline.com/echo', '_blank', 'popup,width=400,height=400')),
  ]);
  await popup.waitForLoadState();
  await sleep(1500); // ggf. einmaliger Reload, falls das Popup vor den Regeln lud
  await popup.waitForLoadState();
  const cPop = await popup.textContent('#cookie').catch(() => '');
  check('Popup (window.open) erbt Container A', /ESTSAUTH=alice/.test(cPop), cPop);

  // 7) Link mit target=_blank erbt den Container
  const [child] = await Promise.all([
    ctx.waitForEvent('page'),
    pB.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'https://outlook.office.com/owa';
      a.target = '_blank';
      document.body.append(a);
      a.click();
    }),
  ]);
  await child.waitForLoadState();
  await sleep(1500);
  await child.waitForLoadState();
  const cChild = await child.textContent('#cookie').catch(() => '');
  check('Neuer Tab (target=_blank) erbt Container B', cChild.trim() === 'OpenIdConnect.token=bob-oidc', cChild);

  // 7b) Leere neue Tabs erben keinen Container, Drag & Drop in die Gruppe schon
  const tabInfo = (t) =>
    sw.evaluate(async (id) => {
      const tab = await chrome.tabs.get(id);
      return { groupId: tab.groupId, badge: await chrome.action.getBadgeText({ tabId: id }) };
    }, t);
  const groupA = (await tabInfo(tabA)).groupId;
  // Strg+T aus einem Container-Tab (Opener gesetzt, Ziel: neue-Tab-Seite)
  const newTab = await sw.evaluate(async (o) => {
    const { windowId } = await chrome.tabs.get(o);
    return (await chrome.tabs.create({ windowId, openerTabId: o, url: 'chrome://newtab/' })).id;
  }, tabA);
  // Chrome setzt einen neuen Tab neben einem gruppierten Tab selbst in die Gruppe
  const autoTab = await sw.evaluate(async (g) => {
    const { windowId } = await chrome.tabGroups.get(g);
    const t = await chrome.tabs.create({ windowId, url: 'chrome://newtab/' });
    await chrome.tabs.group({ tabIds: [t.id], groupId: g });
    return t.id;
  }, groupA);
  await sleep(1500);
  const iNew = await tabInfo(newTab);
  const iAuto = await tabInfo(autoTab);
  check('Strg+T aus Container-Tab: kein Container', iNew.badge === '' && iNew.groupId === -1, JSON.stringify(iNew));
  check('Von Chrome gruppierter neuer Tab: wieder ohne Gruppe/Container', iAuto.badge === '' && iAuto.groupId === -1, JSON.stringify(iAuto));
  // Drag & Drop eines bestehenden Tabs in die Gruppe bleibt möglich
  await sleep(1000);
  await sw.evaluate(([t, g]) => chrome.tabs.group({ tabIds: [t], groupId: g }), [newTab, groupA]);
  await sleep(1000);
  const iDrag = await tabInfo(newTab);
  check('Tab in Gruppe gezogen: wechselt in Container', iDrag.badge === 'TE' && iDrag.groupId === groupA, JSON.stringify(iDrag));
  await sw.evaluate((ids) => chrome.tabs.remove(ids), [newTab, autoTab]);

  // 8) Tab-Gruppen
  const groups = await sw.evaluate(() => chrome.tabGroups.query({}).then((g) => g.map((x) => `${x.title}:${x.color}`)));
  check('Tab-Gruppen mit Name/Farbe', groups.includes('Tenant A:blue') && groups.includes('Tenant B:orange'), groups.join());

  // 9) Umbenennen wirkt auf die Gruppe
  await send({ type: 'container:update', id: A.id, name: 'Contoso', color: 'green' });
  await sleep(300);
  const groups2 = await sw.evaluate(() => chrome.tabGroups.query({}).then((g) => g.map((x) => `${x.title}:${x.color}`)));
  check('Umbenennen aktualisiert Tab-Gruppe', groups2.includes('Contoso:green'), groups2.join());

  if (process.env.SCREENSHOT) {
    await ext.bringToFront();
    await ext.setViewportSize({ width: 360, height: 520 });
    await ext.reload();
    await sleep(300);
    await ext.screenshot({ path: process.env.SCREENSHOT });
  }

  // 10) Sicherung (mit Anmeldungen) vor dem Löschen
  const backup = await send({ type: 'backup:export', includeCookies: true });
  check('Sicherung exportiert', backup.ok && JSON.parse(backup.data).containers.some((c) => c.name === B.name), JSON.stringify(backup).slice(0, 200));
  const bs = await send({ type: 'backup:status' });
  check('Sicherungszeitpunkt gespeichert', bs.ok && typeof bs.data === 'number', JSON.stringify(bs));

  // 11) Löschen eines Containers
  const del = await send({ type: 'container:delete', id: B.id });
  await sleep(1000);
  const st2 = await send({ type: 'popup:state' });
  check('Container gelöscht', del.ok && st2.data.containers.length === 1, JSON.stringify(st2));
  const cAfter = await ctx.pages().find((p) => p.url().includes('outlook.office.com') && p !== pA)?.textContent('#cookie').catch(() => null);
  check('Ehemalige B-Tabs ohne B-Cookies', !/bob/.test(cAfter ?? ''), String(cAfter));

  // 12) Wiederherstellen: Container B samt Anmeldung kommt zurück
  const imp = await send({ type: 'backup:import', json: backup.data });
  check('Sicherung geladen', imp.ok && imp.data.added === 1 && imp.data.cookies > 0, JSON.stringify(imp));
  const st3 = await send({ type: 'popup:state' });
  const B2 = st3.data.containers.find((c) => c.name === B.name);
  check('Container B wiederhergestellt', !!B2 && st3.data.containers.length === 2, JSON.stringify(st3.data.containers));
  if (B2) {
    const t = (await send({ type: 'container:openTab', id: B2.id, url: 'https://outlook.office.com/owa' })).data;
    await sleep(1500);
    const pR = ctx.pages().find((p) => p.url().includes('outlook.office.com/owa') && p !== pA && !/bob/.test(cAfter ?? '') && p.url());
    const texts = await Promise.all(ctx.pages().map((p) => p.textContent('#cookie').catch(() => '')));
    check('Wiederhergestellte Anmeldung wird gesendet', texts.some((x) => /bob/.test(x ?? '')), JSON.stringify(texts));
    void t;
    void pR;
  }
  const upd = await send({ type: 'update:status' });
  check('Update-Status abrufbar', upd.ok && upd.data.current === JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')).version, JSON.stringify(upd));
} catch (e) {
  failed++;
  console.error(e);
} finally {
  await ctx.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(failed ? 1 : 0);
