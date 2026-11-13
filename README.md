# Tenantry

Chrome-Erweiterung (Manifest V3), mit der sich **mehrere Microsoft-365-Tenants gleichzeitig in einem Chrome-Profil** nutzen lassen. Jeder Tenant läuft in einem eigenen **Container**, ähnlich wie die Firefox Multi-Account Containers oder SessionBox.

* Jeder Container wird als **Chrome-Tab-Gruppe** mit eigenem Namen und eigener Farbe dargestellt.
* Container haben **eigene Cookies**: Set-Cookie wird abgefangen, ausgehende Requests erhalten per declarativeNetRequest die Cookies des Containers (HttpOnly/Secure inklusive).
* **localStorage, sessionStorage, IndexedDB** u. a. sind pro Container getrennt, was für MSAL-Tokens wichtig ist.
* Neue Tabs, Popups (`window.open`) und Redirects **erben** den Container.
* Keine Tracker, keine externen Server. Alle Daten bleiben lokal in `chrome.storage`.

> Status: Prototyp (Phase 1). Architektur und bekannte Grenzen stehen in [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Bauen

Voraussetzung: Node.js ≥ 20.

```bash
npm install
npm run build        # erzeugt dist/
npm run dev          # Watch-Modus
npm test             # Unit-Tests (vitest)
npm run typecheck
npm run e2e          # End-to-End-Test (Playwright + Chromium + openssl nötig, siehe unten)
```

## In Chrome laden

1. `npm run build`
2. `chrome://extensions` öffnen und oben rechts den **Entwicklermodus** einschalten.
3. **„Entpackte Erweiterung laden“** klicken und den Ordner `dist/` auswählen.
4. Tenantry an die Symbolleiste anheften (Puzzle-Symbol → Pin).

Beim ersten Start legt Tenantry zwei Container an: **Tenant A** (blau) und **Tenant B** (orange).
Nach Code-Änderungen: neu bauen und in `chrome://extensions` auf ↻ klicken. Offene Container-Tabs werden dabei automatisch wieder zugeordnet und neu geladen.

## Bedienung (Popup)

* **Aktueller Tab:** zeigt den Container des aktiven Tabs. Über „In Container öffnen …“ lässt sich die aktuelle Seite in einem Container neu öffnen.
* **+ Tab:** öffnet die gewählte **Startseite** (Admin Center, Outlook, M365, Entra, Azure) in einem neuen Tab des Containers.
* **✎:** Name und Farbe ändern (die Tab-Gruppe passt sich an).
* **🗑:** Container löschen (zweimal klicken). Seine Tabs verlassen die Gruppe und werden ohne Container neu geladen, seine Cookies werden gelöscht.
* **Erweitert:**
  * *Externe IdPs erlauben*: nötig für föderierte Tenants (ADFS, Okta …), bei denen der Login über eine Nicht-Microsoft-Domain läuft.
  * *Service Worker entfernen*: hilft, wenn eine M365-Seite in einem Container hartnäckig eine falsche Sitzung zeigt.

Ein Tab, den man in die Gruppe eines anderen Containers zieht, wechselt den Container und wird neu geladen.

## Testanleitung: zwei Tenants parallel

Voraussetzung: zwei Konten aus **verschiedenen** Tenants, z. B. `admin@contoso.onmicrosoft.com` und `admin@fabrikam.onmicrosoft.com`.

1. **Vorbereitung:** Am besten in einem frischen Chrome-Profil testen, oder vorher alle M365-Tabs schließen und sich in normalen Tabs bei Microsoft abmelden. Tabs ohne Container nutzen weiterhin Chromes normalen Cookie-Speicher.
2. Popup öffnen → Startseite **„Microsoft 365 Admin Center“** → bei **Tenant A** auf **+ Tab** klicken.
   * Ein Tab in der blauen Gruppe „Tenant A“ öffnet sich, das Symbol trägt das Badge „TE“.
   * Mit Konto **Contoso** anmelden (inkl. MFA).
3. Popup → bei **Tenant B** auf **+ Tab** klicken → mit Konto **Fabrikam** anmelden.
   * Es darf **keine** automatische Anmeldung als Contoso erfolgen. Die Kontoauswahl von Microsoft zeigt Contoso nicht an.
4. Beide Admin Center prüfen: Oben rechts (Profilbild) und unter *Einstellungen → Organisationsprofil* steht jeweils der richtige Tenant.
5. **Outlook Web:** Startseite auf **„Outlook Web“** stellen, dann bei Tenant A und bei Tenant B je **+ Tab** klicken.
   * Ohne erneute Anmeldung (SSO innerhalb des Containers) öffnet sich jeweils das richtige Postfach.
   * Alternativ im Admin-Center-Tab per Strg/Cmd-Klick einen Link auf Outlook öffnen. Der neue Tab landet automatisch in derselben Gruppe.
6. **Parallelbetrieb:** Zwischen den Tabs hin- und herwechseln und in beiden Admin Centern sowie Outlooks Aktionen ausführen (Benutzerliste laden, Mail öffnen). Keine Seite darf in den anderen Tenant springen.
7. **Neu laden / Neustart:** Alle Tabs mit F5 neu laden, dann Chrome komplett beenden und neu starten (Tabs wiederherstellen). Die Gruppen werden über ihren Namen wieder den Containern zugeordnet, die Seiten neu geladen, und bei persistenten Logins („Angemeldet bleiben“) bleiben beide Sitzungen erhalten.
8. **Gegenprobe:** Einen normalen Tab ohne Container auf `https://admin.microsoft.com` öffnen. Hier darf **keiner** der beiden Tenants angemeldet sein.

### Fehlersuche

* **Service-Worker-Konsole:** `chrome://extensions` → Tenantry → „Service Worker“ → Konsole. Hilfreich sind z. B.:
  ```js
  await chrome.declarativeNetRequest.getSessionRules()   // Regeln pro Tab
  await chrome.storage.session.get()                      // Tab→Container
  ```
* **In der Seite (DevTools):** `performance.getEntriesByType('navigation')[0].serverTiming` muss einen Eintrag `tenantry` enthalten.
* **Login-Schleife / falscher Tenant:** Tab neu laden. Hilft das nicht, im Popup *Service Worker entfernen* klicken. Bei föderierten Tenants *Externe IdPs erlauben* aktivieren.
* **Badge „!“:** Die Regeln konnten nicht gesetzt werden (Details in der Service-Worker-Konsole).

## Automatisierte Tests

* `npm test`: Cookie-Parser (RFC 6265, Präfixe, Max-Age), Regel-Generator (Host-only vs. Domain, SameSite, Catch-all, Server-Timing-Payload) und die Konsistenz zwischen Scope und Manifest.
* `npm run e2e`: Startet Chromium mit der Erweiterung und leitet die Microsoft-Hostnamen per `--host-resolver-rules` auf einen lokalen HTTPS-Testserver um. Geprüft werden zwei Container mit Logins inkl. 302-Set-Cookie, Cookie-Header, `fetch`, `document.cookie` (lesen/schreiben, HttpOnly verborgen), localStorage/sessionStorage/IndexedDB, ein Tab ohne Container, `window.open`, `target=_blank`, Tab-Gruppen sowie Umbenennen und Löschen. Benötigt `playwright` (global oder `npm i -D playwright`) und `openssl`. Ersetzt **nicht** den Test mit echten Tenants.

## Datenschutz

Tenantry sendet keinerlei Daten nach außen und enthält keine Analyse- oder Tracking-Funktionen. Container-Cookies liegen in `chrome.storage.local` (persistente Cookies) bzw. `chrome.storage.session` (Session-Cookies) des Chrome-Profils, **unverschlüsselt**. Die Erweiterung sollte daher nur auf vertrauenswürdigen Geräten genutzt werden.

## Lizenz

MIT
