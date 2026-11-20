# Changelog

Alle nennenswerten Änderungen an Tenantry werden hier dokumentiert.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

### Hinzugefügt
- Diagnose-Aufzeichnung im Popup („Diagnose“: Starten, Stoppen, Exportieren, Leeren). Protokolliert für die M365-Domains Requests, Weiterleitungen, Status, gesendete und gesetzte Cookies (nur Namen und Prüfsumme), Formularfeld-Namen und Tenantrys eigene Schritte (Regel-Updates, Wiederholungen, Script-Cookies) und vergleicht die gesendeten Cookies mit dem Container. Cookie-Werte, Token und Formularinhalte werden nicht gespeichert. Die Aufzeichnung endet nach 30 Minuten automatisch und verfällt mit dem Browser.

## [0.3.0] – 2026-11-16

### Geändert
- Feste Erweiterungs-ID `lilkabchipnpplblekhiknflngomlmpk` über `key` im Manifest. Container und Anmeldungen bleiben erhalten, auch wenn die entpackte Erweiterung aus einem anderen Ordner geladen wird. Einmalig beim Umstieg sind die Container leer, weil sich die ID ändert.
- Neues Logo: drei Kacheln in Microsoft-Farben und ein „+“ für einen neuen Tenant. Quelle `static/icons/icon.svg`, PNGs per `scripts/render-icons.mjs`.

## [0.2.0] – 2026-11-16

### Geändert
- Leere neue Tabs (Strg+T, „+“, Lesezeichen, eingetippte Adressen) landen nicht mehr im Container. Setzt Chrome einen neuen Tab von selbst in eine Container-Gruppe, nimmt Tenantry ihn wieder heraus. Container-Tabs entstehen nur noch über „+ Tab“/„In Container öffnen“ im Popup, über Links und Popups einer Container-Seite oder per Drag & Drop in die Gruppe.

## [0.1.1] – 2026-11-16

### Behoben
- SharePoint-Anmeldung in Containern schlug fehl („Das hat leider nicht geklappt“ auf `/_forms/default.aspx` bzw. „Eine Anmeldung ist nicht möglich“). SharePoint setzt `FedAuth`/`rtFa` auf einem 302 und leitet sofort weiter, bevor die DNR-Regeln aktualisiert sind. Tenantry vergleicht jetzt den tatsächlich gesendeten Cookie-Header jeder Seitennavigation (GET) mit dem Container und wiederholt die Navigation, wenn bereits bekannte Cookies fehlten (max. 3× pro 30 s und Tab).

## [0.1.0] – 2026-11-13

Erster Prototyp (Phase 1).

### Hinzugefügt
- Container-Verwaltung: anlegen, umbenennen, löschen; Name und Farbe je Container (gespeichert in `chrome.storage.local`). Beim ersten Start werden „Tenant A“ und „Tenant B“ angelegt.
- Darstellung als Chrome-Tab-Gruppen; neue Tabs, Popups (`window.open`, `target=_blank`) und Redirects erben den Container. Wiederherstellung nach Browser-Neustart über den Gruppentitel.
- Cookie-Isolierung: Set-Cookie (auch auf 30x) wird per `webRequest` erfasst, der Cookie-Header per declarativeNetRequest-Session-Rules (an die Tab-ID gebunden) ersetzt; HttpOnly, Secure, SameSite, Cookie-Präfixe werden berücksichtigt. Native Kopien werden bereinigt.
- Storage-Isolierung im MAIN-World-Script: `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, BroadcastChannel, Web Locks und SharedWorker pro Container; Service-Worker-Registrierung in Containern blockiert.
- Popup: Container-Liste, „+ Tab“ mit wählbarer Startseite, aktueller Container, „In Container öffnen“, Optionen für externe IdPs und Service-Worker-Bereinigung.
- Build mit esbuild, Unit-Tests (vitest), End-to-End-Test mit Chromium.

[Unreleased]: https://github.com/fkroczak/Tenantry/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/fkroczak/Tenantry/releases/tag/v0.3.0
[0.2.0]: https://github.com/fkroczak/Tenantry/releases/tag/v0.2.0
[0.1.1]: https://github.com/fkroczak/Tenantry/releases/tag/v0.1.1
[0.1.0]: https://github.com/fkroczak/Tenantry/releases/tag/v0.1.0
