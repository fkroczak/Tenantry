# Changelog

Alle nennenswerten Änderungen an Tenantry werden hier dokumentiert.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

## [0.1.0] – 2026-11-13

Erster Prototyp (Phase 1).

### Hinzugefügt
- Container-Verwaltung: anlegen, umbenennen, löschen; Name und Farbe je Container (gespeichert in `chrome.storage.local`). Beim ersten Start werden „Tenant A“ und „Tenant B“ angelegt.
- Darstellung als Chrome-Tab-Gruppen; neue Tabs, Popups (`window.open`, `target=_blank`) und Redirects erben den Container. Wiederherstellung nach Browser-Neustart über den Gruppentitel.
- Cookie-Isolierung: Set-Cookie (auch auf 30x) wird per `webRequest` erfasst, der Cookie-Header per declarativeNetRequest-Session-Rules (an die Tab-ID gebunden) ersetzt; HttpOnly, Secure, SameSite, Cookie-Präfixe werden berücksichtigt. Native Kopien werden bereinigt.
- Storage-Isolierung im MAIN-World-Script: `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, BroadcastChannel, Web Locks und SharedWorker pro Container; Service-Worker-Registrierung in Containern blockiert.
- Popup: Container-Liste, „+ Tab“ mit wählbarer Startseite, aktueller Container, „In Container öffnen“, Optionen für externe IdPs und Service-Worker-Bereinigung.
- Build mit esbuild, Unit-Tests (vitest), End-to-End-Test mit Chromium.

[Unreleased]: https://github.com/fkroczak/Tenantry/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fkroczak/Tenantry/releases/tag/v0.1.0
