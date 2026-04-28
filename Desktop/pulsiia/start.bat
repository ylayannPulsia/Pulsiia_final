@echo off
title Pulsiia — Serveur
echo.
echo  Pulsiia — Demarrage du serveur...
echo.

:: Tuer les anciens processus node sur le port 3002
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3002"') do (
    taskkill /F /PID %%a >nul 2>&1
)

cd /d "%~dp0backend"

echo  Ouverture du navigateur dans 3 secondes...
timeout /t 3 /nobreak >nul
start http://localhost:3002

echo  Serveur demarre sur http://localhost:3002
echo  Appuie sur Ctrl+C pour arreter.
echo.
npm run dev
