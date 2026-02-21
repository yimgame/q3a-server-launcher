# Meg & Yim Q3A Server Launcher 🚀

![Quake 3 Arena](https://img.shields.io/badge/Game-Quake%203%20Arena-red.svg)
![Node.js](https://img.shields.io/badge/Backend-Node.js-green.svg)
![Powered By](https://img.shields.io/badge/Developed%20By-Gemini%20AI-blue.svg)

Un panel de control web moderno, dinámico y automatizado para lanzar servidores dedicados de Quake 3 Arena, gestionar mods (CPMA, OSP, DeFRaG, etc.), e indexar y descargar automáticamente mapas faltantes desde múltiples orígenes.

## ✨ Características Principales

- **🎮 Gestión de Perfiles**: Lanza servidores fácilmente con modos de juego configurados (1v1, FFA, TDM, CTF, CA, Freeze Tag) y mods.
- **🌐 FastDL Integrado**: Sirve archivos `.pk3` automáticamente para que los clientes que se conectan descarguen los mods y mapas sin configuración de servidor web de terceros.
- **🌍 Búsqueda Automática de Mapas**: Si escribes un mapa que no tienes, el servidor automáticamente intentará descargarlo en el siguiente orden:
  1. Base de datos local JSON (caché rápida).
  2. Escaneo en vivo de la carpeta `baseq3`.
  3. Carpeta FTP local (Ej. un repositorio de mapas descargados previamente), copiándolos y catalogándolos on-the-fly.
  4. Búsqueda y descarga inteligente desde la API de **LvLWorld**.
  5. Intercepción de descarga en espectros de servidores directos de la comunidad (ej. sst13.de).
  6. Si todo falla, mostrará un enlace directo a Google configurado para encontrar el mapa.
- **🖼️ Interfaz Web Dinámica**: Temas visuales personalizables (Dark, Ocean Animado, Retro Terminal), auto-completado de mapas con visualización de nivel (*levelshots*), y una terminal de combate o consola que muestra la actividad del servidor en vivo vía WebSockets.
- **⚙️ Escáner en Segundo Plano**: Al iniciar, un servicio no bloqueante parsea todos tus archivos `.pk3` localizando los archivos `.arena` para extraer automáticamente los nombres técnicos, nombres completos, tipos de juego y extraer las capturas de pantalla de cada mapa para mostrárselas al usuario en la web.

## 🚀 Requisitos

- **Node.js**: Instalado en el sistema (idealmente v18 o superior).
- **Quake 3 Arena**: Una instalación local del juego accesible por el servidor.
- Instalar las dependencias de Node:
  ```bash
  npm install
  ```

## 🛠️ Configuración (.env)

Debes crear un archivo `.env` en la raíz del proyecto para definir las rutas absolutas a tu instalación del juego:

```env
Q3_PATH=G:\Games\Quake3
BASEQ3_PATH=G:\Games\Quake3\baseq3
LOCAL_MAPS_FTP=G:\Games\Quake3\ftp
SERVER_DL_URL=http://tu.servidor.com/
MAP_CONFIGS_PATH=G:\Games\Quake3\cpma\cfg-maps
MOD_CONFIGS_PATH=G:\Games\Quake3\cpma\cfg
```

## 💻 Uso

Para arrancar el servidor web de Node.js:
```bash
npm run dev
```
o
```bash
npx tsx server.ts
```

Una vez iniciado, ingresa a `http://localhost` desde tu navegador. El servidor hará un escaneo en segundo plano de tus mapas y luego el panel te permitirá levantar instancias independientes de `ioq3ded`.

---

### Menciones

Desarrollado y automatizado con el esfuerzo conjunto del usuario y el Asistente de IA **Google Gemini / Antigravity**. 
*Hecho para amantes puros de los Arena FPS.*
