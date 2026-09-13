import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync, createWriteStream, readFileSync } from 'fs';
import AdmZip from 'adm-zip';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';
import Docker from 'dockerode';
import dgram from 'dgram';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OLD_JSON_DB_PATH = path.join(__dirname, 'maps_db.json'); // solo para la migración única
const SQLITE_DB_PATH = path.join(__dirname, 'maps.db');
const PREVIEWS_PATH = path.join(__dirname, 'public', 'previews');

if (!existsSync(PREVIEWS_PATH)) mkdirSync(PREVIEWS_PATH, { recursive: true });

// --- BASE DE DATOS DE MAPAS (SQLite) ---
// Antes esto era un JSON gigante cargado entero en memoria (mapsCache), lo que
// generaba bugs feos: una búsqueda pisando el progreso de un escaneo en curso
// (pasó de verdad, ver comentario en /api/maps más abajo), y nada de escritura
// concurrente segura. SQLite maneja lecturas/escrituras concurrentes de forma
// nativa sin que tengamos que inventar nuestra propia sincronización.
const db = new DatabaseSync(SQLITE_DB_PATH);
db.exec(`
    CREATE TABLE IF NOT EXISTS maps (
        bsp TEXT NOT NULL,
        pk3 TEXT NOT NULL,
        loc TEXT,
        longname TEXT,
        type TEXT,
        levelshot TEXT,
        PRIMARY KEY (bsp, pk3)
    );
    -- Registro de qué pk3 ya fueron escaneados, tengan o no mapas adentro.
    -- Sin esto, un pk3 sin ningún .arena (texturas, sonidos, etc.) nunca
    -- aparece en "maps" y el censo lo vuelve a marcar como "nuevo" para
    -- siempre en cada arranque -- pasó de verdad, 632 pk3 reescaneados en cada
    -- restart sin necesidad.
    CREATE TABLE IF NOT EXISTS scanned_pk3 (
        pk3 TEXT PRIMARY KEY
    );
`);

const stmtUpsertMap = db.prepare(`
    INSERT INTO maps (bsp, pk3, loc, longname, type, levelshot) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bsp, pk3) DO UPDATE SET loc=excluded.loc, longname=excluded.longname,
        type=excluded.type, levelshot=excluded.levelshot
`);
const stmtFindByBsp = db.prepare(`SELECT * FROM maps WHERE bsp = ? LIMIT 1`);
const stmtExistsKey = db.prepare(`SELECT 1 FROM maps WHERE bsp = ? AND pk3 = ? LIMIT 1`);
const stmtAllMaps = db.prepare(`SELECT * FROM maps`);
const stmtDistinctPk3 = db.prepare(`SELECT pk3 FROM scanned_pk3`);
const stmtCountMaps = db.prepare(`SELECT COUNT(*) as c FROM maps`);
const stmtMarkScanned = db.prepare(`INSERT OR IGNORE INTO scanned_pk3 (pk3) VALUES (?)`);

function upsertMap(m: { bsp: string; pk3: string; loc?: string; longname?: string; type?: string; levelshot?: string | null }) {
    stmtUpsertMap.run(m.bsp.toLowerCase(), (m.pk3 || '').toLowerCase(), m.loc || null, m.longname || null, m.type || null, m.levelshot || null);
}

// Busca por nombre técnico (bsp) sin importar de qué pk3 vino -- se usa para lanzar
// el server (donde solo tenemos el bsp que eligió el usuario) y para info en vivo.
// Si hay varias entradas con el mismo bsp, devuelve la primera que encuentre.
function findMapByBsp(bsp: string): any | null {
    const target = (bsp || '').toLowerCase();
    if (!target) return null;
    return stmtFindByBsp.get(target) || null;
}

function mapExists(bsp: string, pk3: string): boolean {
    return !!stmtExistsKey.get((bsp || '').toLowerCase(), (pk3 || '').toLowerCase());
}

// Migración única desde el maps_db.json viejo (si existe y la tabla está vacía).
{
    const alreadyHasData = (stmtCountMaps.get() as any).c > 0;
    if (!alreadyHasData && existsSync(OLD_JSON_DB_PATH)) {
        const oldData = JSON.parse(readFileSync(OLD_JSON_DB_PATH, 'utf8'));
        let migrated = 0;
        const insertMany = db.prepare(`INSERT OR IGNORE INTO maps (bsp, pk3, loc, longname, type, levelshot) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const v of Object.values(oldData) as any[]) {
            if (!v?.bsp) continue;
            insertMany.run((v.bsp || '').toLowerCase(), (v.pk3 || '').toLowerCase(), v.loc || null, v.longname || null, v.type || null, v.levelshot || null);
            if (v.pk3) stmtMarkScanned.run((v.pk3 || '').toLowerCase());
            migrated++;
        }
        console.log(`[Migración] ${migrated} mapas importados de maps_db.json a SQLite (maps.db).`);
    }
}

// --- CONFIG (.env) ---
// Q3_PATH: ruta del volumen de Quake3 vista DESDE ESTE container (para escanear/bajar mapas).
// Q3_HOST_PATH: la MISMA ruta pero vista desde el HOST del Docker (para los binds de los containers
//               que este launcher crea vía el socket de Docker -- son rutas distintas a propósito).
const { Q3_PATH, Q3_HOST_PATH, Q3_HOST_IP, BASEQ3_PATH, LOCAL_MAPS_FTP, SERVER_DL_URL, MAP_CONFIGS_PATH, MOD_CONFIGS_PATH } = process.env;

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const Q3_IMAGE = 'ubuntu:24.04';

const app = express();
// 1. Servir archivos estáticos (fotos, css, js) desde la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 1.5. Exponer carpetas de mapas y mods para que los clientes del juego puedan descargarlos (FastDL)
if (Q3_PATH) {
    const mods = ['baseq3', 'cpma', 'missionpack', 'osp', 'arena', 'alliance', 'DeFRaG', 'excessiveplus', 'invacion'];
    for (const modFolder of mods) {
        const modPath = path.join(Q3_PATH, modFolder);
        if (existsSync(modPath)) {
            app.use(`/${modFolder}`, (req, res, next) => {
                // Filtro de seguridad: Solo permitir descargar archivos .pk3
                const cleanPath = req.path.split('?')[0].toLowerCase();
                if (cleanPath.endsWith('.pk3')) {
                    next();
                } else {
                    res.status(403).send('Acceso denegado: Solo se permiten descargas de mapas (.pk3)');
                }
            }, express.static(modPath));
        }
    }
}

const httpServer = createServer(app);
const io = new Server(httpServer);

// Perfiles de modo -> puerto/carpeta propios, para NO chocar con los 6 servers fijos
// (FFA/1v1/2v2/TDM/CTF/CA) que ya corren en 27960-27965 con sus propias carpetas srv_*.
// Este launcher usa 28060+ y carpetas launcher_* para instancias bajo demanda, totalmente aparte.
const PROFILES: any = {
    '1v1': { port: 28060, mode: 1, cfg: 'yimq3a-cpma-1v1-server-gemini.cfg', mapCfg: '1v1maps.cfg', folder: 'launcher_1v1' },
    'ffa': { port: 28061, mode: 0, cfg: 'yimq3a-cpma-ffa-server-gemini.cfg', mapCfg: 'ffamaps.cfg', folder: 'launcher_ffa' },
    'tdm': { port: 28062, mode: 3, cfg: 'yimq3a-cpma-tdm-server-gemini.cfg', mapCfg: 'tdmmaps.cfg', folder: 'launcher_tdm' },
    'ctf': { port: 28063, mode: 4, cfg: 'yimq3a-cpma-ctf-server-gemini.cfg', mapCfg: 'ctfmaps.cfg', folder: 'launcher_ctf' },
    'ca': { port: 28064, mode: 5, cfg: 'yimq3a-cpma-ca-server-gemini.cfg', mapCfg: 'camaps.cfg', folder: 'launcher_ca' },
    'ftag': { port: 28065, mode: 6, cfg: 'yimq3a-cpma-ftag-server-gemini.cfg', mapCfg: 'ftagmaps.cfg', folder: 'launcher_ftag' },
    'ctfs': { port: 28066, mode: 7, cfg: 'yimq3a-cpma-ctfs-server-gemini.cfg', mapCfg: 'ctfsmaps.cfg', folder: 'launcher_ctfs' },
    'ra': { port: 28067, mode: 8, cfg: 'yimq3a-cpma-ra-server-gemini.cfg', mapCfg: 'ramaps.cfg', folder: 'launcher_ra' }
};

// Info del último mapa lanzado por modo (bsp/longname/levelshot), para mostrar
// en la lista de servers activos sin tener que re-parsear el pk3 cada vez.
const currentMatches: Record<string, any> = {};

// Últimos parámetros de lanzamiento por modo (para poder "reiniciar" sin que el
// usuario tenga que volver a elegir mapa/mod desde cero).
const lastLaunchParams: Record<string, { modName: string; mapBsp: string }> = {};

// Stream de stdin ya adjuntado a cada container corriendo, para poder mandarle
// comandos de consola (rcon-like) sin tener que abrir un attach nuevo por cada
// comando.
const stdinStreams: Record<string, any> = {};

function closeStdinStream(modeKey: string) {
    const s = stdinStreams[modeKey];
    if (s) {
        try { s.end(); } catch (e) { }
        delete stdinStreams[modeKey];
    }
}

// Consulta en vivo "getstatus" (protocolo nativo Quake3) al server dado.
// Devuelve hostname/map/jugadores reales, o null si no contesta.
function queryGameServer(port: number, timeoutMs = 1500): Promise<any | null> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let done = false;
        const finish = (result: any | null) => {
            if (done) return;
            done = true;
            try { socket.close(); } catch (e) { }
            resolve(result);
        };

        const timer = setTimeout(() => finish(null), timeoutMs);

        socket.on('message', (msg) => {
            clearTimeout(timer);
            try {
                const text = msg.toString('utf8');
                const lines = text.split('\n').filter(l => l.length > 0);
                // Línea 0: cabecera OOB + "statusResponse". Línea 1: \key\value\key\value...
                const infoLine = lines[1] || '';
                const parts = infoLine.split('\\').filter(p => p.length > 0);
                const info: Record<string, string> = {};
                for (let i = 0; i < parts.length - 1; i += 2) info[parts[i]] = parts[i + 1];

                const players = lines.slice(2).map(l => {
                    const m = l.match(/^(-?\d+)\s+(-?\d+)\s+"(.*)"$/);
                    if (!m) return null;
                    return { score: parseInt(m[1], 10), ping: parseInt(m[2], 10), name: m[3] };
                }).filter(Boolean);

                finish({ hostname: info.sv_hostname, map: info.mapname, gametype: info.g_gametype, players });
            } catch (e) {
                finish(null);
            }
        });

        socket.on('error', () => finish(null));

        // Ojo: este launcher corre en red bridge, pero los servers de juego usan
        // network_mode: host -> viven en el namespace de red del HOST, no en el
        // nuestro. "127.0.0.1" acá sería nuestro propio loopback, no el del host.
        const packet = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('getstatus')]);
        socket.send(packet, port, Q3_HOST_IP);
    });
}

// Solo dejamos pasar caracteres seguros para lo que termina en un comando de shell dentro del container nuevo
function sanitize(value: string, fallback: string): string {
    const cleaned = (value || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
    return cleaned || fallback;
}

// --- ESCÁNER DE .ARENA (BUSCA NOMBRE LARGO -> NOMBRE TÉCNICO) ---
function scanPk3ForMap(pk3Path: string, query: string): any | null {
    try {
        const zip = new AdmZip(pk3Path);
        const arenaEntries = zip.getEntries().filter(e => e.entryName.toLowerCase().endsWith('.arena'));

        for (const entry of arenaEntries) {
            const content = entry.getData().toString('utf8');
            const blocks = content.split('{');
            for (const block of blocks) {
                if (block.toLowerCase().includes(query.toLowerCase())) {
                    const bspMatch = block.match(/map\s+"([^"]+)"/i) || block.match(/map\s+([^\s\n\r]+)/i);
                    const longMatch = block.match(/longname\s+"([^"]+)"/i);
                    const typeMatch = block.match(/type\s+"([^"]+)"/i) || block.match(/type\s+([^\s\n\r]+)/i);

                    if (bspMatch) {
                        const bsp = bspMatch[1] || bspMatch[0].split(/\s+/)[1].replace(/"/g, '');
                        const technicalName = bsp.trim().toLowerCase();

                        const shotEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === `levelshots/${technicalName}.jpg`);
                        if (shotEntry) {
                            zip.extractEntryTo(shotEntry, PREVIEWS_PATH, false, true);
                        }

                        return {
                            bsp: technicalName,
                            pk3: path.basename(pk3Path),
                            loc: 'baseq3',
                            longname: longMatch ? longMatch[1] : query,
                            type: typeMatch ? typeMatch[1].toLowerCase() : 'unknown',
                            levelshot: shotEntry ? `/previews/${technicalName}.jpg` : null
                        };
                    }
                }
            }
        }
    } catch (e) { console.error("Error PK3:", e); }
    return null;
}

// --- BUSCADOR FTP LOCAL ---
async function checkLocalFtp(query: string): Promise<any | null> {
    const ftpPathEnv = LOCAL_MAPS_FTP?.split(' ')[0];
    if (!ftpPathEnv || !existsSync(ftpPathEnv)) return null;
    try {
        const ftpFiles = readdirSync(ftpPathEnv).filter(f => f.toLowerCase().endsWith('.pk3'));
        for (const file of ftpFiles) {
            if (file.toLowerCase().includes(query.toLowerCase())) {
                const ftpFileFull = path.join(ftpPathEnv, file);
                const result = scanPk3ForMap(ftpFileFull, query);
                if (result) {
                    const destPath = path.join(BASEQ3_PATH!, file);
                    copyFileSync(ftpFileFull, destPath);
                    return scanPk3ForMap(destPath, query);
                }
            }
        }
    } catch (e) { console.error("Error checkLocalFtp:", e); }
    return null;
}

// --- DESCARGA DESDE LVLWORLD ---
async function downloadFromLvL(mapName: string): Promise<any | null> {
    try {
        const query = mapName.trim();
        const formData = new URLSearchParams();
        formData.append('q', query);
        formData.append('m', '1');

        const { data: searchResults } = await axios.post('https://lvlworld.com/reworkSearch', formData);
        if (!searchResults || searchResults.length === 0) return null;

        const firstMatchId = searchResults[0].id;
        const mapPageRes = await axios.get(`https://lvlworld.com/review/id:${firstMatchId}`);
        const match = mapPageRes.data.match(/location="\/dl\/"\+\s*s\s*\+"\/(.*?)";/);
        if (!match) return null;

        const dlUrl = "https://lvlworld.com/dl/lvl/" + match[1];
        const dlRes = await axios.get(dlUrl, { maxRedirects: 0, validateStatus: null });
        if (dlRes.status !== 302 || !dlRes.headers.location) return null;

        const downloadUrl = dlRes.headers.location;

        const zipPath = path.join(__dirname, 'temp.zip');
        const resp = await axios({ url: downloadUrl, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });

        await new Promise(r => resp.data.pipe(createWriteStream(zipPath)).on('finish', r));

        const zip = new AdmZip(zipPath);
        let result = null;

        for (const e of zip.getEntries()) {
            if (e.entryName.toLowerCase().endsWith('.pk3')) {
                const fullPath = path.join(BASEQ3_PATH!, e.entryName);
                zip.extractEntryTo(e, BASEQ3_PATH!, false, true);
                result = scanPk3ForMap(fullPath, query);
                if (result) result.fuente = downloadUrl;
            }
        }

        unlinkSync(zipPath);
        return result;
    } catch (e) { console.error("LvL download err:", e); return null; }
}

// --- DESCARGA DIRECTA HTTP MIRRORS ---
async function downloadFromDirectUrls(mapName: string): Promise<any | null> {
    const urlsToTry = [
        `https://sst13.de/${encodeURIComponent(mapName)}.pk3`
    ];

    for (const dUrl of urlsToTry) {
        try {
            const headRes = await axios.head(dUrl, { validateStatus: null, headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (headRes.status === 200) {
                const pk3Name = `${mapName.toLowerCase()}.pk3`;
                const fullPath = path.join(BASEQ3_PATH!, pk3Name);
                const resp = await axios({ url: dUrl, responseType: 'stream', headers: { 'User-Agent': 'Mozilla/5.0' } });
                await new Promise(r => resp.data.pipe(createWriteStream(fullPath)).on('finish', r));

                const result = scanPk3ForMap(fullPath, mapName);
                if (result) {
                    result.fuente = dUrl;
                    return result;
                }
            }
        } catch (e) {
            console.error("Direct URL error:", e);
        }
    }
    return null;
}

// --- DOCKER: lanzar / parar servers bajo demanda ---
// Importante: los binds de Docker se resuelven en el HOST, no dentro de este container.
// Por eso usamos Q3_HOST_PATH (la ruta real en el 101) para los Binds, aunque este mismo
// launcher use Q3_PATH (su propio mount interno) para leer/escribir mapas localmente.
async function stopModeContainer(modeKey: string): Promise<void> {
    const containerName = `q3launcher-${modeKey}`;
    delete currentMatches[modeKey];
    closeStdinStream(modeKey);
    try {
        const c = docker.getContainer(containerName);
        await c.remove({ force: true });
    } catch (e: any) {
        if (e.statusCode !== 404) console.error(`No se pudo remover ${containerName}:`, e.message);
    }
}

async function launchModeContainer(modeKey: string, profile: any, modName: string, mapBsp: string): Promise<string> {
    const containerName = `q3launcher-${modeKey}`;
    await stopModeContainer(modeKey); // limpia instancia previa del mismo modo, si había

    const safeMod = sanitize(modName, 'cpma');
    const safeMap = sanitize(mapBsp, 'q3dm1');
    const homePath = `/game/instances/${profile.folder}`;

    // Ojo: chmod/mkdir son sentencias SEPARADAS (una por línea real), solo los
    // argumentos del binario van encadenados con continuación de línea "\".
    // Si se juntan todas con "\" quedan como UN solo comando y "|| true" se come
    // el resto de la línea como argumentos ignorados (no arranca nada).
    const argLines = [
        `+set fs_basepath /game`,
        `+set fs_homepath ${homePath}`,
        `+set fs_game ${safeMod}`,
        `+set dedicated 2`,
        `+set net_port ${profile.port}`,
        `+set sv_allowDownload 1`,
        `+set sv_dlURL "${SERVER_DL_URL}"`,
        `+set sv_pure 0`,
        `+set com_hunkMegs 512`,
        `+set com_zoneMegs 128`,
        `+set com_soundMegs 128`,
        `+set g_gametype ${profile.mode}`,
        `+exec cfg/${profile.cfg}`,
        `+map ${safeMap}`
    ].join(' \\\n');

    const shellCmd = [
        `chmod +x /game/ioq3ded.x86_64 || true`,
        `mkdir -p ${homePath}`,
        `/game/ioq3ded.x86_64 \\\n${argLines}`
    ].join('\n');

    const container = await docker.createContainer({
        name: containerName,
        Image: Q3_IMAGE,
        Tty: false,
        OpenStdin: true, // deja el stdin abierto para poder mandarle comandos de consola
        StdinOnce: false,
        AttachStdin: true,
        Cmd: ['bash', '-lc', shellCmd],
        HostConfig: {
            NetworkMode: 'host',
            Binds: [`${Q3_HOST_PATH}:/game:rw`],
            RestartPolicy: { Name: 'unless-stopped' }
        }
    });
    await container.start();
    lastLaunchParams[modeKey] = { modName: safeMod, mapBsp: safeMap };

    // Nos adjuntamos al stdin del container para poder mandarle comandos de
    // consola después (ver socket 'send_command'). Si falla no es grave --
    // simplemente no vamos a poder mandar comandos a este server.
    try {
        const attachStream: any = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
        stdinStreams[modeKey] = attachStream;
    } catch (e: any) {
        console.error(`No se pudo adjuntar stdin a ${containerName}:`, e.message);
    }

    return containerName;
}

async function killAllLauncherContainers(): Promise<string[]> {
    const killed: string[] = [];
    for (const modeKey of Object.keys(PROFILES)) {
        const name = `q3launcher-${modeKey}`;
        delete currentMatches[modeKey];
        closeStdinStream(modeKey);
        try {
            const c = docker.getContainer(name);
            await c.remove({ force: true });
            killed.push(name);
        } catch (e: any) {
            if (e.statusCode !== 404) console.error(`Error matando ${name}:`, e.message);
        }
    }
    return killed;
}

io.on('connection', (socket) => {
    socket.on('launch', async (data) => {
        const { mode, mapName } = data;
        const modeKey = PROFILES[mode] ? mode : 'ctf';
        const profile = PROFILES[modeKey];
        const q = (mapName || '').toLowerCase().trim();

        socket.emit('status', `🔍 Buscando "${mapName}"...`);

        // 1. Buscar en la DB por bsp (puede haber varias entradas del mismo bsp
        // en pk3 distintos, tomamos la primera; el archivo que realmente carga el
        // juego lo decide Quake3 por su propia prioridad de paks, no esta elección)
        let mapInfo = findMapByBsp(q);

        if (mapInfo && mapInfo.loc === 'ftp') {
            socket.emit('status', `📂 Copiando ${mapInfo.pk3} desde FTP local...`);
            const ftpPathEnv = LOCAL_MAPS_FTP?.split(' ')[0];
            if (ftpPathEnv) {
                const srcPath = path.join(ftpPathEnv, mapInfo.pk3);
                const destPath = path.join(BASEQ3_PATH!, mapInfo.pk3);
                if (existsSync(srcPath)) {
                    copyFileSync(srcPath, destPath);
                    mapInfo.loc = 'baseq3';
                }
            }
        }

        // 2. Scan Local PK3s if not in Cache
        if (!mapInfo) {
            const pk3Files = readdirSync(BASEQ3_PATH!).filter(f => f.endsWith('.pk3'));
            for (const file of pk3Files) {
                mapInfo = scanPk3ForMap(path.join(BASEQ3_PATH!, file), q);
                if (mapInfo) break;
            }
        }

        // 3. FTP Local
        if (!mapInfo) {
            socket.emit('status', `📂 Buscando en servidor FTP local...`);
            mapInfo = await checkLocalFtp(q);
            if (mapInfo) socket.emit('status', `✅ Encontrado en Local FTP.`);
        }

        // 4. Download from LvLWorld if still not found
        if (!mapInfo) {
            socket.emit('status', `🌐 Buscando en LvLWorld...`);
            mapInfo = await downloadFromLvL(q);
            if (mapInfo) socket.emit('status', `✅ Descargado de LvLWorld.`);
        }

        // 5. Download from Direct URLs
        if (!mapInfo) {
            socket.emit('status', `🌐 Buscando en Espejos Directos...`);
            mapInfo = await downloadFromDirectUrls(q);
            if (mapInfo) socket.emit('status', `✅ Descargado desde Mirror Directo.`);
        }

        if (!mapInfo) {
            const searchLink = `https://www.google.com/search?q=quake+3+map+download+${encodeURIComponent(mapName.trim())}`;
            socket.emit('status', `❌ Mapa no encontrado.`);
            socket.emit('map_search_fallback', { mapName, url: searchLink });
            return;
        }

        // Guardar en DB
        upsertMap(mapInfo);

        // Búsqueda manual de un mapa que no estaba indexado: aprovechamos para
        // chequear si aparecieron pk3 nuevos en general (censo rápido, no bloquea
        // esta búsqueda -- fire and forget).
        quickCensusAndScan().catch(() => { });

        // Enviar info al Panel (Foto y Link)
        socket.emit('map_found', mapInfo);

        // --- LANZAR SERVIDOR (container Docker, bajo demanda, aparte de los 6 fijos) ---
        try {
            socket.emit('status', `🚀 Lanzando container para "${modeKey}"...`);
            await launchModeContainer(modeKey, profile, data.mod, mapInfo.bsp);
            currentMatches[modeKey] = { ...mapInfo, launchedAt: Date.now() };
            socket.emit('status', `🚀 Servidor Online: ${mapInfo.bsp} (puerto ${profile.port})`);
            socket.emit('server_launched', { connect: `${Q3_HOST_IP}:${profile.port}` });
        } catch (e: any) {
            console.error('Error lanzando container:', e);
            socket.emit('status', `❌ Error lanzando el server: ${e.message}`);
        }
    });

    socket.on('kill_all', async () => {
        socket.emit('status', '💀 Aniquilando servidores del launcher...');
        const killed = await killAllLauncherContainers();
        socket.emit('status', killed.length ? `💀 Aniquilados: ${killed.join(', ')}` : '💀 No había servidores del launcher corriendo.');
    });

    // --- CONSOLA EN VIVO POR SERVIDOR (modal) ---
    // Cada server de juego corre como PID 1 de su propio container, así que su
    // consola real (fragged, connected, chat, etc.) ES el stdout/stderr del
    // container -- no hace falta tailear ningún archivo de log. Un socket mira
    // como mucho un server a la vez (al abrir otro modal se corta el anterior).
    let consoleStream: any = null;
    function stopConsoleStream() {
        if (consoleStream) {
            try { consoleStream.destroy(); } catch (e) { }
            consoleStream = null;
        }
    }

    socket.on('watch_console', async (modeKey: string) => {
        stopConsoleStream();
        const containerName = `q3launcher-${modeKey}`;
        try {
            const container = docker.getContainer(containerName);
            const stream: any = await container.logs({ follow: true, stdout: true, stderr: true, tail: 150 });
            consoleStream = stream;
            const emitLine = (chunk: Buffer) => {
                socket.emit('console_line', { mode: modeKey, text: chunk.toString('utf8') });
            };
            // demuxStream separa el multiplexado de Docker (stdout/stderr en un
            // mismo stream con headers) en dos streams de texto planos.
            container.modem.demuxStream(stream, { write: emitLine }, { write: emitLine });
            stream.on('error', () => { });
        } catch (e: any) {
            socket.emit('console_line', { mode: modeKey, text: `[No se pudo conectar a la consola: ${e.message}]` });
        }
    });

    socket.on('unwatch_console', () => stopConsoleStream());
    socket.on('disconnect', () => stopConsoleStream());

    // Manda un comando de consola (rcon-like) al stdin del server ya corriendo.
    // Ej: "map q3dm6", "kick all", "say hola", cualquier comando de consola nativo.
    socket.on('send_command', ({ mode, command }: { mode: string; command: string }) => {
        const stream = stdinStreams[mode];
        if (!stream) {
            socket.emit('console_line', { mode, text: '[No hay conexión de consola activa a este server]' });
            return;
        }
        try {
            stream.write(command + '\n');
        } catch (e: any) {
            socket.emit('console_line', { mode, text: `[Error mandando comando: ${e.message}]` });
        }
    });

    // Reinicia el server con los mismos mapa/mod/modo con los que se lanzó la
    // última vez (así no hay que volver a elegir todo desde cero).
    socket.on('restart_server', async (modeKey: string) => {
        const profile = PROFILES[modeKey];
        const last = lastLaunchParams[modeKey];
        if (!profile || !last) {
            socket.emit('status', `❌ No hay datos previos para reiniciar "${modeKey}".`);
            return;
        }
        socket.emit('status', `🔁 Reiniciando ${modeKey}...`);
        try {
            await launchModeContainer(modeKey, profile, last.modName, last.mapBsp);
            socket.emit('status', `✅ ${modeKey} reiniciado.`);
            socket.emit('server_restarted', modeKey);
        } catch (e: any) {
            socket.emit('status', `❌ Error reiniciando: ${e.message}`);
        }
    });

    // Apaga (borra) el container de este server puntual.
    socket.on('stop_server', async (modeKey: string) => {
        socket.emit('status', `🛑 Deteniendo ${modeKey}...`);
        await stopModeContainer(modeKey);
        socket.emit('status', `🛑 ${modeKey} detenido.`);
        socket.emit('server_stopped', modeKey);
    });
});


// 2. Ruta principal (Asegurate que index.html esté en la misma carpeta que server.ts)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Ruta para el favicon
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'favicon.ico'));
});

// API de mapas para la UI.
// SQLite lee directo del archivo en cada consulta (no hay una "copia en memoria"
// separada que se pueda pisar), así que una búsqueda nunca puede cortarle el
// paso a un escaneo en curso ni viceversa -- son lecturas/escrituras normales de
// la DB, cada una su propia transacción.
app.get('/api/maps', (req, res) => {
    const rows = stmtAllMaps.all() as any[];
    const out: Record<string, any> = {};
    for (const row of rows) {
        out[`${row.bsp}::${row.pk3}`] = row;
    }
    res.json(out);
    // Censo rápido en segundo plano al cargar la página -- no bloquea esta
    // respuesta, solo dispara un escaneo si hay pk3 nuevos sin indexar.
    quickCensusAndScan().catch(() => { });
});

// Fuerza un escaneo completo de todo baseq3 (lo que antes hacía el scanner
// SIEMPRE al arrancar). Usar esto solo si sospechás que el CONTENIDO de un pk3
// cambió sin cambiar su nombre de archivo -- el censo rápido no detecta eso,
// solo detecta pk3 nuevos/eliminados por nombre.
app.post('/api/rescan', async (req, res) => {
    const result = await fullRescan();
    res.json(result);
});

// Estado de los containers que maneja este launcher
app.get('/api/status', async (req, res) => {
    const result: any = {};
    for (const modeKey of Object.keys(PROFILES)) {
        const name = `q3launcher-${modeKey}`;
        try {
            const c = docker.getContainer(name);
            const info = await c.inspect();
            result[modeKey] = { running: info.State.Running, port: PROFILES[modeKey].port, startedAt: info.State.StartedAt };
        } catch (e) {
            result[modeKey] = { running: false, port: PROFILES[modeKey].port };
        }
    }
    res.json(result);
});

// Lista de servers activos con datos en vivo (mapa, jugadores, hostname) para la UI.
// Busca longname/levelshot del mapa que esté corriendo AHORA (vía mapsCache, la
// misma DB que llena el escaneo de fondo), en vez de depender solo de lo que se
// lanzó al principio -- así funciona también si el server rotó de mapa solo.
function getMapMeta(mapBsp: string | undefined, launched: any) {
    const cached = mapBsp ? findMapByBsp(mapBsp) : null;
    // "launched" es el mapa con el que se LANZÓ el server originalmente -- solo
    // sirve de fallback si el mapa en vivo sigue siendo ESE MISMO (si alguien
    // cambió de mapa por consola, mostrar los datos del mapa viejo sería
    // directamente incorrecto, mejor mostrar el bsp pelado que mentir).
    const stillSameMap = launched && launched.bsp === mapBsp;
    return {
        longname: cached?.longname || (stillSameMap ? launched?.longname : null) || mapBsp || '?',
        levelshot: cached?.levelshot || (stillSameMap ? launched?.levelshot : null) || null
    };
}

app.get('/api/servers', async (req, res) => {
    const servers: any[] = [];
    for (const modeKey of Object.keys(PROFILES)) {
        const profile = PROFILES[modeKey];
        const name = `q3launcher-${modeKey}`;
        let running = false;
        let startedAt: string | undefined;
        try {
            const c = docker.getContainer(name);
            const info = await c.inspect();
            running = info.State.Running;
            startedAt = info.State.StartedAt;
        } catch (e) { /* no existe, running queda false */ }

        if (!running) continue;

        const live = await queryGameServer(profile.port);
        const launched = currentMatches[modeKey];
        const mapBsp = live?.map || launched?.bsp;
        const meta = getMapMeta(mapBsp, launched);

        servers.push({
            mode: modeKey,
            port: profile.port,
            startedAt,
            hostname: live?.hostname || launched?.longname || modeKey.toUpperCase(),
            map: mapBsp || '?',
            longname: meta.longname,
            levelshot: meta.levelshot,
            players: live?.players || []
        });
    }
    res.json(servers);
});

// Detalle de un server puntual (para el modal al hacer click en la lista)
app.get('/api/servers/:mode', async (req, res) => {
    const modeKey = req.params.mode;
    const profile = PROFILES[modeKey];
    if (!profile) return res.status(404).json({ error: 'Modo desconocido' });

    const name = `q3launcher-${modeKey}`;
    let running = false;
    try {
        const c = docker.getContainer(name);
        const info = await c.inspect();
        running = info.State.Running;
    } catch (e) { /* no corre */ }

    if (!running) return res.status(404).json({ error: 'Ese server no está activo' });

    const live = await queryGameServer(profile.port);
    const launched = currentMatches[modeKey];
    const mapBsp = live?.map || launched?.bsp;
    const meta = getMapMeta(mapBsp, launched);
    res.json({
        mode: modeKey,
        port: profile.port,
        hostname: live?.hostname || launched?.longname || modeKey.toUpperCase(),
        map: mapBsp || '?',
        longname: meta.longname,
        levelshot: meta.levelshot,
        players: live?.players || []
    });
});

// --- ESCANEO REACTIVO (no barre todo todo el tiempo) ---
// Antes esto SIEMPRE hacía un barrido completo de los 2000+ pk3 al arrancar,
// tardando ~1 minuto cada vez aunque no hubiera un solo archivo nuevo. Ahora:
// - quickCensusAndScan(): compara nombres de pk3 en disco vs. ya indexados
//   (rápido, solo readdir + una consulta SQL) y escanea SOLO los que faltan.
//   Se dispara al arrancar, al cargar /api/maps, y al buscar un mapa no
//   indexado -- así reacciona rápido a pk3 nuevos sin recorrer todo siempre.
// - fullRescan(): el barrido completo de antes, para cuando hace falta a mano
//   (POST /api/rescan) -- por si el CONTENIDO de un pk3 cambió sin renombrarse,
//   algo que el censo por nombre no puede detectar.
function listPk3Files(): { file: string; fullPath: string; loc: string }[] {
    let foldersToScan: { path: string, loc: string }[] = [];
    if (BASEQ3_PATH && existsSync(BASEQ3_PATH)) foldersToScan.push({ path: BASEQ3_PATH, loc: 'baseq3' });

    const ftpPathEnv = LOCAL_MAPS_FTP?.split(' ')[0];
    if (ftpPathEnv && existsSync(ftpPathEnv)) foldersToScan.push({ path: ftpPathEnv, loc: 'ftp' });

    let pk3Files: { file: string, fullPath: string, loc: string }[] = [];
    for (const folder of foldersToScan) {
        const files = readdirSync(folder.path).filter(f => f.toLowerCase().endsWith('.pk3'));
        for (const f of files) {
            pk3Files.push({ file: f, fullPath: path.join(folder.path, f), loc: folder.loc });
        }
    }
    return pk3Files;
}

// Escanea UN pk3 y agrega a la DB los mapas que le falten. Devuelve cuántos agregó.
function scanOnePk3(pk3Obj: { file: string; fullPath: string; loc: string }): number {
    let added = 0;
    try {
        const zip = new AdmZip(pk3Obj.fullPath);
        const arenaEntries = zip.getEntries().filter(e => e.entryName.toLowerCase().endsWith('.arena'));
        for (const entry of arenaEntries) {
            const content = entry.getData().toString('utf8');
            const blocks = content.split('{');
            for (const block of blocks) {
                const bspMatch = block.match(/map\s+"([^"]+)"/i) || block.match(/map\s+([^\s\n\r]+)/i);
                const longMatch = block.match(/longname\s+"([^"]+)"/i);
                const typeMatch = block.match(/type\s+"([^"]+)"/i) || block.match(/type\s+([^\s\n\r]+)/i);

                if (bspMatch) {
                    const bsp = bspMatch[1] || bspMatch[0].split(/\s+/)[1].replace(/"/g, '');
                    const technicalName = bsp.trim().toLowerCase();

                    if (!mapExists(technicalName, pk3Obj.file)) {
                        const shotEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === `levelshots/${technicalName}.jpg`);
                        if (shotEntry) {
                            try { zip.extractEntryTo(shotEntry, PREVIEWS_PATH, false, true); } catch (e) { }
                        }
                        upsertMap({
                            bsp: technicalName,
                            pk3: pk3Obj.file,
                            loc: pk3Obj.loc,
                            longname: longMatch ? longMatch[1] : technicalName,
                            type: typeMatch ? typeMatch[1].toLowerCase() : 'unknown',
                            levelshot: shotEntry ? `/previews/${technicalName}.jpg` : null
                        });
                        added++;
                    }
                }
            }
        }
    } catch (e: any) {
        // Antes era 100% silencioso -- lo logueamos para poder detectar pk3s
        // corruptos (ej: "zpak000_assets.pk3" con zip inválido) sin tener que
        // adivinar por qué faltan mapas.
        console.error(`[Scanner] No se pudo leer ${pk3Obj.file}:`, e?.message || e);
    }
    // Lo marcamos como escaneado tenga o no mapas (o incluso si tiró error) --
    // así el censo no lo vuelve a agarrar en cada arranque. Si el usuario quiere
    // forzar un reintento (ej. arregló un pk3 corrupto) usa POST /api/rescan.
    stmtMarkScanned.run(pk3Obj.file.toLowerCase());
    return added;
}

// Escanea una lista de pk3 en lotes de a 100 (cede el event loop entre lotes,
// no archivo por archivo) para no trabar el server mientras corre.
function scanFiles(files: { file: string; fullPath: string; loc: string }[], label: string): Promise<number> {
    return new Promise((resolve) => {
        if (files.length === 0) { resolve(0); return; }
        console.log(`[Scanner] ${label}: escaneando ${files.length} pk3...`);
        const BATCH_SIZE = 100;
        let added = 0;
        const step = (startIndex: number) => {
            if (startIndex >= files.length) {
                console.log(`[Scanner] ${label}: listo, ${added} mapas nuevos.`);
                resolve(added);
                return;
            }
            const endIndex = Math.min(startIndex + BATCH_SIZE, files.length);
            for (let i = startIndex; i < endIndex; i++) added += scanOnePk3(files[i]);
            setTimeout(() => step(endIndex), 0);
        };
        step(0);
    });
}

let censusInProgress = false;
let lastCensusAt = 0;
const CENSUS_MIN_INTERVAL_MS = 15000; // no chequear más seguido que esto

async function quickCensusAndScan(): Promise<{ scanned: number; added: number }> {
    if (censusInProgress) return { scanned: 0, added: 0 };
    const now = Date.now();
    if (now - lastCensusAt < CENSUS_MIN_INTERVAL_MS) return { scanned: 0, added: 0 };
    lastCensusAt = now;
    censusInProgress = true;
    try {
        const onDisk = listPk3Files();
        const indexed = new Set((stmtDistinctPk3.all() as any[]).map((r: any) => r.pk3));
        const nuevos = onDisk.filter(f => !indexed.has(f.file.toLowerCase()));
        if (nuevos.length === 0) return { scanned: 0, added: 0 };
        const added = await scanFiles(nuevos, `Censo (${nuevos.length} pk3 nuevos)`);
        return { scanned: nuevos.length, added };
    } finally {
        censusInProgress = false;
    }
}

async function fullRescan(): Promise<{ scanned: number; added: number }> {
    const files = listPk3Files();
    const added = await scanFiles(files, `Barrido completo (${files.length} pk3)`);
    return { scanned: files.length, added };
}

// 3. RECIÉN AL FINAL, el listen
const PORT = parseInt(process.env.LAUNCHER_PORT || '80', 10);
httpServer.listen(PORT, () => {
    console.log(`🌐 Panel Meg & Yim: http://localhost:${PORT}`);
    // Al arrancar con la DB recién migrada (vacía) esto termina siendo un
    // barrido completo por única vez; en reinicios normales solo escanea los
    // pk3 nuevos que hayan aparecido desde la última vez.
    quickCensusAndScan().catch(e => console.error('[Scanner] Error en censo inicial:', e));
});
