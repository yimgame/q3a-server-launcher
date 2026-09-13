@echo off
title Q3 Map Database Builder
echo Escaneando todos los mapas y reconstruyendo maps_db.json...
npx tsx build_db.ts
echo.
pause
