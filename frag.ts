import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, unlinkSync } from 'fs';
import AdmZip from 'adm-zip';
import path from 'path';
import inquirer from 'inquirer';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Validación de .env
const { Q3_PATH, BASEQ3_PATH, MAP_CONFIGS_PATH, LOCAL_MAPS_FTP, SERVER_DL_URL } = process.env;

if (!Q3_PATH || !BASEQ3_PATH) {
    console.error("❌ ERROR: No se pudieron cargar las variables del .env");
    console.error("Asegurate de que el archivo .env existe en la raíz y tiene Q3_PATH definido.");
    process.exit(1);
}

const PROFILES: any = {
    'ctf': { port: 27960, mode: 4, cfg: 'ctf.cfg', folder: 'srv_ctf' },
    'tdm': { port: 27961, mode: 3, cfg: 'tdm.cfg', folder: 'srv_tdm' },
    '1v1': { port: 27962, mode: 1, cfg: '1v1.cfg', folder: 'srv_1v1' },
    'ffa': { port: 27963, mode: 0, cfg: 'ffa.cfg', folder: 'srv_ffa' }
};

function findMapInAnyPk3(mapName: string, folder: string): string | null {
    if (!existsSync(folder)) return null;
    const pk3Files = readdirSync(folder).filter(f => f.toLowerCase().endsWith('.pk3'));

    for (const file of pk3Files) {
        try {
            const fullPath = path.join(folder, file);
            const zip = new AdmZip(fullPath);
            const mapEntry = zip.getEntries().find(e => 
                e.entryName.toLowerCase() === `maps/${mapName.toLowerCase()}.bsp`
            );
            if (mapEntry) return fullPath;
        } catch (e) { continue; }
    }
    return null;
}

async function searchLvLWorld(query: string) {
    try {
        const { data: html } = await axios.get(`https://lvlworld.com{encodeURIComponent(query)}`);
        const $ = cheerio.load(html);
        const results: any[] = [];
        $('.listing').each((_, el) => {
            const titleEl = $(el).find('h3 a');
            const id = titleEl.attr('href')?.split(':').pop();
            if (id) results.push({ id, name: titleEl.text().trim(), author: $(el).find('.meta').text().trim() });
        });
        return results;
    } catch (e) { return []; }
}

async function main() {
    console.log("\n=== Meg & Yim Q3 Server Manager ===\n");

    const { modName } = await inquirer.prompt([{
        type: 'list',
        name: 'modName',
        message: '¿Con qué MOD querés arrancar?',
        choices: ['cpma', 'osp', 'excessiveplus', 'baseq3']
    }]);

    const { profileKey } = await inquirer.prompt([{
        type: 'list',
        name: 'profileKey',
        message: '¿Qué servidor querés levantar?',
        choices: Object.keys(PROFILES)
    }]);
    const profile = PROFILES[profileKey];

    const { mapInput } = await inquirer.prompt([{
        type: 'input',
        name: 'mapInput',
        message: 'Nombre del mapa:',
        validate: (v) => v.length > 0 ? true : 'Poné un nombre.'
    }]);

    let finalMapName = mapInput;
    let pk3Path = findMapInAnyPk3(mapInput, BASEQ3_PATH!);

    if (!pk3Path) {
        console.log(`[!] "${mapInput}" no está en baseq3. Buscando en FTP local...`);
        const ftpPk3Path = findMapInAnyPk3(mapInput, LOCAL_MAPS_FTP!);

        if (ftpPk3Path) {
            console.log(`[+] ¡Encontrado! Copiando ${path.basename(ftpPk3Path)} a baseq3...`);
            copyFileSync(ftpPk3Path, path.join(BASEQ3_PATH!, path.basename(ftpPk3Path)));
        } else {
            const { tryLvL } = await inquirer.prompt([{ 
                type: 'confirm', 
                name: 'tryLvL', 
                message: 'No está local. ¿Bajar de LvLWorld?', 
                default: true 
            }]);
            
            if (tryLvL) {
                const results = await searchLvLWorld(mapInput);
                if (results.length > 0) {
                    const { selected } = await inquirer.prompt([{
                        type: 'list',
                        name: 'selected',
                        message: 'Resultados en LvLWorld:',
                        choices: results.map(r => ({ name: `${r.name} - ${r.author}`, value: r }))
                    }]);
                    
                    console.log(`[*] Descargando...`);
                    const response = await axios({ url: `https://lvlworld.com{selected.id}`, responseType: 'stream' });
                    const zipPath = path.join(__dirname, 'temp.zip');
                    const writer = createWriteStream(zipPath);
                    response.data.pipe(writer);
                    await new Promise((r) => writer.on('finish', r));
                    
                    const zip = new AdmZip(zipPath);
                    zip.getEntries().forEach(e => {
                        if (e.entryName.endsWith('.pk3')) {
                            zip.extractEntryTo(e, BASEQ3_PATH!, false, true);
                            finalMapName = e.entryName.replace('.pk3', '');
                        }
                    });
                    unlinkSync(zipPath);
                } else { return; }
            } else { return; }
        }
    }

    const homePath = path.join(Q3_PATH!, 'instances', profile.folder);
    if (!existsSync(homePath)) mkdirSync(homePath, { recursive: true });

    const args = [
        '+set', 'fs_homepath', homePath,
        '+set', 'fs_game', modName,
        '+set', 'dedicated', '2',
        '+set', 'net_port', profile.port.toString(),
        '+set', 'sv_allowDownload', '1',
        '+set', 'sv_dlURL', SERVER_DL_URL!,
        '+set', 'g_gametype', profile.mode.toString(),
        '+exec', path.join(MAP_CONFIGS_PATH!, profile.cfg),
        '+map', finalMapName
    ];

    console.log(`\n🚀 LANZANDO SERVIDOR...`);
    spawn(path.join(Q3_PATH!, 'ioq3ded.exe'), args, {
        cwd: Q3_PATH,
        detached: true,
        stdio: 'inherit'
    }).unref();

    console.log(`\n¡Servidor arriba! /connect yim.servegame.com:${profile.port}`);
    process.exit();
}

main().catch(err => console.error(err));
