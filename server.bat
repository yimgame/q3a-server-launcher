@echo off
echo Arrancando motores...
start /b npx ts-node server.ts
ngrok http --url=treva-segreant-grizzly.ngrok-free.dev 80

