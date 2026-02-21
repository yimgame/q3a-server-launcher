import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { spawn, exec } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, unlinkSync, createWriteStream, readFileSync } from 'fs';
import { Tail } from 'tail';
import AdmZip from 'adm-zip';
import axios from 'axios';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'maps_db.json');
const PREVIEWS_PATH = path.join(__dirname, 'public', 'previews');

if (!existsSync(PREVIEWS_PATH)) mkdirSync(PREVIEWS_PATH, { recursive: true });

// --- BASE DE DATOS DE MAPAS (JSON) ---
let mapsCache: any = existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, 'utf8')) : {};

//q3_path=G:\Games\Quake3
// baseq3_path=G:\Games\Quake3\baseq3
// local_maps_ftp=G:\Games\Quake3\ftp
// server_dl_url=http://yim.servegame.com/
// map_configs_path=G:\Games\Quake3\cpma\cfg-maps
// mod_configs_path=G:\Games\Quake3\cpma\cfg
const { Q3_PATH, BASEQ3_PATH, LOCAL_MAPS_FTP, SERVER_DL_URL, MAP_CONFIGS_PATH, MOD_CONFIGS_PATH } = process.env;

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
                console.log(`[FastDL] URL: ${req.originalUrl}, req.path: ${req.path}, modPath: ${modPath}`);
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

const PROFILES: any = {
    '1v1': { port: 27960, mode: 1, cfg: 'yimq3a-cpma-1v1-server-gemini.cfg', mapCfg: '1v1maps.cfg', folder: 'srv_1v1' },
    'ffa': { port: 27961, mode: 0, cfg: 'yimq3a-cpma-ffa-server-gemini.cfg', mapCfg: 'ffamaps.cfg', folder: 'srv_ffa' },
    'tdm': { port: 27962, mode: 3, cfg: 'yimq3a-cpma-tdm-server-gemini.cfg', mapCfg: 'tdmmaps.cfg', folder: 'srv_tdm' },
    'ctf': { port: 27963, mode: 4, cfg: 'yimq3a-cpma-ctf-server-gemini.cfg', mapCfg: 'ctfmaps.cfg', folder: 'srv_ctf' },
    'ca': { port: 27964, mode: 5, cfg: 'yimq3a-cpma-ca-server-gemini.cfg', mapCfg: 'camaps.cfg', folder: 'srv_ca' },
    'ftag': { port: 27965, mode: 6, cfg: 'yimq3a-cpma-ftag-server-gemini.cfg', mapCfg: 'ftagmaps.cfg', folder: 'srv_ftag' },
    'ctfs': { port: 27966, mode: 7, cfg: 'yimq3a-cpma-ctfs-server-gemini.cfg', mapCfg: 'ctfsmaps.cfg', folder: 'srv_ctfs' },
    'ra': { port: 27967, mode: 8, cfg: 'yimq3a-cpma-ra-server-gemini.cfg', mapCfg: 'ramaps.cfg', folder: 'srv_ra' }
};


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

                        // Extraer Levelshot (Miniatura)
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

io.on('connection', (socket) => {
    socket.on('launch', async (data) => {
        const { mode, mapName } = data;
        const profile = PROFILES[mode] || PROFILES['ctf'];
        const q = mapName.toLowerCase().trim();

        socket.emit('status', `🔍 Buscando "${mapName}"...`);

        // 1. Check JSON Cache
        let mapInfo = mapsCache[q];

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
        mapsCache[q] = mapInfo;
        writeFileSync(DB_PATH, JSON.stringify(mapsCache, null, 2));

        // Enviar info al Panel (Foto y Link)
        socket.emit('map_found', mapInfo);

        // --- LANZAR SERVIDOR ---
        const homePath = path.join(Q3_PATH!, 'instances', profile.folder);
        const logPath = path.join(homePath, data.mod, 'console.log');

        const args = [
            '+set', 'fs_homepath', homePath,
            '+set', 'fs_game', data.mod,
            '+set', 'dedicated', '2',
            '+set', 'net_port', profile.port.toString(),
            '+set', 'sv_dlURL', SERVER_DL_URL!, //https://treva-segreant-grizzly.ngrok-free.dev/
            '+set', 'sv_pure', '0',
            '+set', 'g_gametype', profile.mode.toString(),
            '+exec', path.join(MAP_CONFIGS_PATH!, profile.mapCfg),
            '+exec', path.join(MOD_CONFIGS_PATH!, profile.cfg),
            '+map', mapInfo.bsp
        ];

        spawn('cmd', ['/c', 'start', 'ioq3ded.x86_64.exe', ...args], { cwd: Q3_PATH, detached: true, shell: true }).unref();

        socket.emit('status', `🚀 Servidor Online: ${mapInfo.bsp}`);
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

// API de mapas para la UI
app.get('/api/maps', (req, res) => {
    res.json(mapsCache);
});

// --- ESCANEO EN SEGUNDO PLANO AL INICIAR EL SERVIDOR ---
function runBackgroundScanner() {
    let foldersToScan: { path: string, loc: string }[] = [];
    if (BASEQ3_PATH && existsSync(BASEQ3_PATH)) foldersToScan.push({ path: BASEQ3_PATH, loc: 'baseq3' });

    const ftpPathEnv = LOCAL_MAPS_FTP?.split(' ')[0];
    if (ftpPathEnv && existsSync(ftpPathEnv)) foldersToScan.push({ path: ftpPathEnv, loc: 'ftp' });

    if (foldersToScan.length === 0) return;

    let pk3Files: { file: string, fullPath: string, loc: string }[] = [];
    for (const folder of foldersToScan) {
        const files = readdirSync(folder.path).filter(f => f.toLowerCase().endsWith('.pk3'));
        for (const f of files) {
            pk3Files.push({ file: f, fullPath: path.join(folder.path, f), loc: folder.loc });
        }
    }

    console.log(`\n[Scanner] Iniciando escaneo de mapas en segundo plano (${pk3Files.length} archivos)...`);
    let added = 0;

    const scanBatch = (startIndex: number) => {
        if (startIndex >= pk3Files.length) {
            if (added > 0) {
                writeFileSync(DB_PATH, JSON.stringify(mapsCache, null, 2));
                console.log(`[Scanner] Escaneo finalizado. Se añadieron ${added} mapas nuevos a la DB.`);
            } else {
                console.log(`[Scanner] Escaneo finalizado. No hay mapas nuevos (DB actualizada).`);
            }
            return;
        }

        const pk3Obj = pk3Files[startIndex];
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

                        if (!mapsCache[technicalName]) { // Evitamos reprocesar si ya está en caché
                            const shotEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === `levelshots/${technicalName}.jpg`);
                            if (shotEntry) {
                                try { zip.extractEntryTo(shotEntry, PREVIEWS_PATH, false, true); } catch (e) { }
                            }

                            mapsCache[technicalName] = {
                                bsp: technicalName,
                                pk3: pk3Obj.file,
                                loc: pk3Obj.loc,
                                longname: longMatch ? longMatch[1] : technicalName,
                                type: typeMatch ? typeMatch[1].toLowerCase() : 'unknown',
                                levelshot: shotEntry ? `/previews/${technicalName}.jpg` : null
                            };
                            added++;
                        }
                    }
                }
            }
        } catch (e) {
            // Ignoramos errores de lectura en el background
        }

        // Programar el siguiente archivo en el Event Loop para no bloquear Express
        setTimeout(() => scanBatch(startIndex + 1), 10);
    };

    scanBatch(0);
}

// 3. RECIÉN AL FINAL, el listen
httpServer.listen(80, () => {
    console.log('🌐 Panel Meg & Yim: http://localhost:80');
    runBackgroundScanner();
});