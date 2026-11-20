@echo off
rem Tenantry aktualisieren (Doppelklick). Container bleiben erhalten.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
echo.
pause
