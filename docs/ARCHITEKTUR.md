# Tenantry – Architektur

## Überblick

```
┌───────────────────────── Chrome-Profil ──────────────────────────────┐
│                                                                      │
│  Popup (popup.html/ts)  ──runtime.sendMessage──►  Service Worker     │
│                                                   (background.js)    │
│                                                   ├─ state.ts   Container, Tab→Container, Gruppe→Container
│                                                   ├─ jar.ts     Cookie-Speicher je Container
│                                                   ├─ capture.ts Set-Cookie abfangen (webRequest, beobachtend)
│                                                   ├─ rules.ts   DNR-Regeln berechnen (rein, getestet)
│                                                   ├─ dnr.ts     Session-Rules je Tab anwenden
│                                                   └─ groups.ts  Tab-Gruppen (Name/Farbe)
│                                                        │  ▲
│                       DNR Session Rules (tabIds=[tab]) │  │ webRequest.onHeadersReceived
│                       • Cookie-Header  := Container    ▼  │ (Set-Cookie, extraHeaders)
│  Tab (Container A) ───────── Netzwerk ──────────────► login.microsoftonline.com, *.office.com …
│    │                  • Server-Timing  := {cid, JS-Cookies}
│    ├─ content-main.js   (MAIN, document_start)
│    │     document.cookie / localStorage / sessionStorage / IndexedDB /
│    │     CacheStorage / BroadcastChannel / Web Locks / SharedWorker → Container-Namensraum
│    └─ content-bridge.js (ISOLATED) ◄── CustomEvent ──► MAIN
│             ▲ runtime.sendMessage / tabs.sendMessage
│             └────────────────────────────────► Service Worker
└──────────────────────────────────────────────────────────────────────┘
```

## Dateistruktur

| Pfad | Zweck |
|---|---|
| `static/manifest.json` | MV3-Manifest (Berechtigungen, Content-Scripts) |
| `src/shared/scope.ts` | Scope-Domains (eine Quelle der Wahrheit, Test prüft das Manifest) |
| `src/shared/cookies.ts` | RFC-6265-Parser, Domain-/Pfad-Matching, Serialisierung |
| `src/shared/payload.ts` | Kodierung des Kontexts für den `Server-Timing`-Header |
| `src/shared/types.ts` | Container-Modell, Farben, Nachrichtentypen |
| `src/background/*` | Service Worker (siehe Diagramm) |
| `src/content/main.ts` | Isolierung in der Seite (MAIN-World) |
| `src/content/bridge.ts` | Vermittler Seite ↔ Service Worker (ISOLATED-World) |
| `src/popup/*` | Popup-UI (ohne Framework) |
| `scripts/build.mjs` | esbuild-Build nach `dist/`, erzeugt Icons |
| `test/*.test.ts` | Unit-Tests (vitest) |
| `e2e/*` | End-to-End-Test mit echtem Chromium und lokalem HTTPS-Server |

## Datenflüsse

### 1. Container ↔ Tab
* Zuordnung `tabId → containerId` in `chrome.storage.session` (überlebt das Schlafen des Service Workers).
* Jeder Container wird pro Fenster als **Tab-Gruppe** mit seinem Namen und seiner Farbe dargestellt.
* **Vererbung:** `tabs.onCreated` (openerTabId) und `webNavigation.onCreatedNavigationTarget` (window.open, `target=_blank`). Redirects bleiben im selben Tab und damit im Container.
* Zieht der Benutzer einen Tab in die Gruppe eines anderen Containers, wechselt der Tab den Container und wird neu geladen. Ein Tab, der aus seiner Gruppe entfernt wird, wird wieder einsortiert (Container sind pro Tab fest).
* **Neustart:** Tab- und Gruppen-IDs sind nach einem Browser-Neustart neu. Die Zuordnung wird über den **Titel der Tab-Gruppe** wiederhergestellt; betroffene Tabs werden einmal neu geladen.

### 2. Cookies (Netzwerk)
1. `webRequest.onHeadersReceived` mit `extraHeaders` liest `Set-Cookie`, auch bei 30x-Redirects. Die Cookies werden geparst (Domain, Pfad, Ablauf, Secure, HttpOnly, SameSite, `__Host-`/`__Secure-`) und im Speicher des Containers abgelegt.
2. Persistente Cookies liegen in `storage.local`, Session-Cookies in `storage.session` (verfallen mit dem Browser).
3. Für jeden Container-Tab erzeugt `rules.ts` **declarativeNetRequest-Session-Rules** mit `tabIds:[tab]`:
   * `exact(host)`: `urlFilter "|https://host/"`, enthält Host-only-Cookies und passende Domain-Cookies
   * `sub(domain)`: `requestDomains:[domain]`, enthält nur Domain-Cookies
   * eine Catch-all-Regel (Priorität 1), die für alle Scope-Domains den Cookie-Header **entfernt**
   * die Priorität steigt mit der Spezifität; bei `modifyHeaders` gewinnt für denselben Header die höchste Priorität.
   * SameSite=Strict-Cookies nur bei einem Initiator derselben Site (`initiatorDomains`)
4. Der Cookie-Header wird **ersetzt**. Der native Cookie-Speicher von Chrome spielt für Container-Tabs damit keine Rolle.
5. Weil MV3 das Speichern nativer Cookies nicht blockieren kann, löscht `capture.ts` die nativen Kopien sofort wieder (`cookies.onChanged` + `cookies.remove`). So werden Tabs ohne Container nicht versehentlich in einen Container-Tenant eingeloggt.

### 3. Seite (document.cookie & Storage)
* Dieselben DNR-Regeln setzen in jeder Antwort `Server-Timing: tenantry;desc="<base64url{cid, JS-Cookies}>"`.
* `content-main.js` liest diesen Wert bei `document_start` **synchron** über `performance.getEntriesByType('navigation')[0].serverTiming`. Damit sind Container-ID und Cookies vor dem ersten Seiten-Script bekannt, was für MSAL entscheidend ist.
* Fallbacks: Kontext des Elternfensters (about:blank-Frames) bzw. eine Markierung im nativen sessionStorage. Die Bridge bestätigt den Container asynchron; bei Abweichung oder fehlenden Regeln wird die Seite **einmal** neu geladen (max. 2× pro Minute).
* Überschrieben werden:
  * `document.cookie` → Container-Cookies (HttpOnly unsichtbar). Schreibzugriffe gehen über die Bridge in den Speicher.
  * `localStorage`/`sessionStorage` → Proxy mit Schlüsselpräfix `__tnty:<cid>:`, inkl. gefilterter `storage`-Events
  * `indexedDB`, `caches`, `BroadcastChannel`, `navigator.locks`, `SharedWorker` → Namenspräfix `tenantry:<cid>:`
  * `navigator.serviceWorker.register` → blockiert; vorhandene Registrierungen werden entfernt
  * `cookieStore` → deaktiviert

## Bekannte Grenzen

| Thema | Grenze | Umgang im Prototyp |
|---|---|---|
| **MV3 webRequest** | Kein blockierendes `webRequest`: Set-Cookie lässt sich nicht verhindern, nur beobachten. Header-Änderungen nur deklarativ (DNR). | Natives Cookie wird nach dem Erfassen gelöscht. **Empfehlung: M365 nur in Containern nutzen.** Gleichnamige Cookies einer „normalen“ Sitzung können kurz überschrieben werden. |
| **Timing** | Die DNR-Regeln werden asynchron aktualisiert (Millisekunden). Ein Redirect direkt nach Set-Cookie kann noch mit den alten Cookies laufen. | In Tests unkritisch. Bei Login-Schleifen den Tab einmal neu laden. |
| **Initiator-Berechtigung** | DNR `modifyHeaders` verlangt Host-Rechte für Ziel **und** Initiator. Föderierte Logins (ADFS, Okta, PingFederate …) springen von fremden Domains zurück. | Optionale Berechtigung „Externe IdPs erlauben“ im Popup (`https://*/*`). |
| **Service Worker der Seiten** | Requests eines Service Workers haben `tabId = -1` und lassen sich keinem Tab und damit keinem Container zuordnen. | In Containern wird die Registrierung blockiert, vorhandene SWs werden abgemeldet. Popup-Button entfernt SWs/Caches der M365-Origins. Offline-Funktionen von Outlook entfallen in Containern. |
| **IndexedDB / Cache Storage** | Pro Origin geteilt, nicht pro Container. | Namenspräfix je Container (best effort). Daten gelöschter Container bleiben in der Origin liegen. |
| **Login-Redirects / Popups** | Ein per `window.open` geöffnetes Popup kann schon laden, bevor seine Regeln aktiv sind. MSAL-Popups sind eigene Fenster und lassen sich nicht gruppieren. | Container wird vererbt; fehlt der Server-Timing-Kontext, lädt die Seite einmal neu. Das Badge zeigt den Container auch im Popup. |
| **Cookie-Pfade** | DNR-Regeln werden pro Host und Domain erzeugt, nicht pro Pfad. | Bei gleichnamigen Cookies gewinnt der längste Pfad. Microsoft verwendet fast nur `Path=/`. |
| **SameSite** | Nur angenähert (Strict per `initiatorDomains`, Lax wie None). | Für M365 ausreichend (Auth-Cookies sind `SameSite=None`). |
| **Andere Kontexte** | Prefetch/Preconnect, Downloads, `navigator.sendBeacon` nach Tab-Schließen, Requests anderer Erweiterungen | Nicht isoliert. |
| **Isolation ≠ Sicherheitsgrenze** | Scripts derselben Origin können den nativen Speicher direkt lesen (z. B. über ein about:blank-iframe). | Schutz gegen versehentliches Vermischen, nicht gegen bösartige Seiten. |
| **Speicherung** | Container-Cookies (inkl. Refresh-Token-Cookies) liegen unverschlüsselt in `chrome.storage.local`. | Nur auf vertrauenswürdigen Geräten nutzen. Container löschen entfernt die Cookies. |
| **Limits** | max. 5000 Session-Rules (ca. 2–30 pro Tab) | Bei Fehler zeigt das Badge „!“. |
| **Inkognito** | nicht unterstützt (`incognito: not_allowed`) | – |

## Scope

Gefordert: `login.microsoftonline.com`, `login.live.com`, `*.office.com`, `*.microsoft.com`, `*.sharepoint.com`, `outlook.office.com`, `admin.microsoft.com`, `portal.azure.com`, `entra.microsoft.com`.

Ergänzt, weil Microsoft dorthin umleitet: `*.cloud.microsoft` (z. B. `admin.cloud.microsoft`, `outlook.cloud.microsoft`, `m365.cloud.microsoft`), `*.office365.com` (`outlook.office365.com`), `login.windows.net`.
Die drei Berechtigungen `microsoftonline.com`, `live.com` und `windows.net` (nur die Apex-Domain) dienen allein dazu, native Kopien von Domain-Cookies zu löschen.

Statische Inhalte (`*.msauth.net`, `*.office.net`, `*.cdn.office.net` …) kommen ohne Cookies aus und bleiben bewusst außerhalb des Scopes.
