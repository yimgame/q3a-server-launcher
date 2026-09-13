@echo off
title Q3A Server Launcher - Menú Principal
chcp 65001 >nul
color 0A

rem 1. Cambia la imagen de fondo (reemplaza con la ruta de tu imagen)
rem echo  ]11;G:\OBS\Fraging Times\Fragging Times_.jpg 
rem cls


:menu
cls
echo =====================================================================
echo  ██████╗ ██████╗  █████╗    ███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗
echo ██╔═══██╗╚════██╗██╔══██╗   ██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
echo ██║   ██║ █████╔╝╚██████║   ███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝
echo ██║▄▄ ██║ ╚═══██╗ ╚═══██║   ╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗
echo ╚██████╔╝██████╔╝ █████╔╝   ███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
echo  ╚══▀▀═╝ ╚═════╝  ╚════╝    ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝
echo =====================================================================
echo                     MENÚ PRINCIPAL DE CONTROL
echo =====================================================================
echo.
echo    [1] Iniciar Servidor Node (Backend Launcher)
echo    [2] Iniciar Túnel Ngrok (Acceso Público)
echo    [3] Configurar y Lanzar Stream (YouTube Studio + OBS)
echo    [4] Abrir Panel Web Local (http://localhost)
echo    [5] Lanzar Quake 3 Arena (Conectar al Servidor)
echo.
echo    [6] Lanzamiento Rápido Todo-en-Uno (Modo Directo + Servidor + Juego)
echo    [7] Salir
echo.
echo =====================================================================
choice /c 1234567 /n /m "   Elige una opción [1-7]: "
set CHOICE_ANS=%errorlevel%

if "%CHOICE_ANS%"=="1" goto opt_node
if "%CHOICE_ANS%"=="2" goto opt_ngrok
if "%CHOICE_ANS%"=="3" goto opt_stream
if "%CHOICE_ANS%"=="4" goto opt_chrome
if "%CHOICE_ANS%"=="5" goto opt_game
if "%CHOICE_ANS%"=="6" goto opt_all
if "%CHOICE_ANS%"=="7" goto opt_exit

:opt_node
echo.
echo [+] Iniciando Servidor Node (Server Launcher)...
start "Server Launcher" npx ts-node server.ts
echo [+] Esperando 5 segundos...
timeout /t 5 >nul
goto menu

:opt_ngrok
echo.
echo [+] Iniciando Túnel Ngrok...
start "NGROK" ngrok http --url=treva-segreant-grizzly.ngrok-free.dev 80
echo [+] Esperando 5 segundos...
timeout /t 5 >nul
goto menu

:opt_stream
echo.
echo [+] Abriendo Panel de Control de YouTube Studio en Chrome...
start chrome "https://studio.youtube.com/channel/UCUw4qVhmndumwRlvJmqHcJw/livestreaming/dashboard"
echo [+] Iniciando OBS Studio con escena 'Q3' y transmisión automática...
start "OBS" /d "C:\Program Files\obs-studio\bin\64bit" "obs64.exe" --scene "Q3" --startstreaming
echo [+] Esperando 10 segundos...
timeout /t 10 >nul
goto menu

:opt_chrome
echo.
echo [+] Abriendo panel web local en Chrome...
start chrome "http://localhost/"
timeout /t 2 >nul
goto menu

:opt_game
echo.
echo [+] Iniciando Quake 3 Arena y conectando a 192.168.0.4:27963...
start "Q3a CPMA CTF" "G:\Games\Quake3\cnq3-x64.exe" +connect 192.168.0.4:27963
timeout /t 3 >nul
goto menu

:opt_all
echo.
echo =====================================================================
echo  EJECUTANDO LANZAMIENTO COMPLETO (TODO-EN-UNO)
echo =====================================================================
echo.
echo [+] 1/5. Iniciando Servidor Node...
start "Server Launcher" npx ts-node server.ts
timeout /t 10 >nul

echo [+] 2/5. Iniciando Túnel Ngrok...
start "NGROK" ngrok http --url=treva-segreant-grizzly.ngrok-free.dev 80
timeout /t 10 >nul

echo [+] 3/5. Abriendo YouTube Studio y lanzando OBS...
start chrome "https://studio.youtube.com/channel/UCUw4qVhmndumwRlvJmqHcJw/livestreaming/dashboard"
start "OBS" /d "C:\Program Files\obs-studio\bin\64bit" "obs64.exe" --scene "Q3" --startstreaming
timeout /t 30 >nul

echo [+] 4/5. Abriendo Dashboard Local...
start chrome "http://localhost/"
timeout /t 5 >nul

echo [+] 5/5. Lanzando Quake 3 Arena...
start "Q3a CPMA CTF" "G:\Games\Quake3\cnq3-x64.exe" +connect 192.168.0.4:27963
echo.
echo [+] ¡Lanzamiento Todo-en-Uno completado con éxito!
timeout /t 5 >nul
goto menu

:opt_exit
rem echo  ]110 
rem cls
echo.
echo ¡Hasta la próxima! Saliendo...
timeout /t 2 >nul
exit


