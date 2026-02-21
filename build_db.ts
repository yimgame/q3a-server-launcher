import 'dotenv/config';
import { existsSync, readdirSync, writeFileSync, readFileSync } from 'fs';
import AdmZip from 'adm-zip';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'maps_db.json');
const PREVIEWS_PATH = path.join(__dirname, 'public', 'previews');

const BASEQ3_PATH = process.env.BASEQ3_PATH;

if (!BASEQ3_PATH || !existsSync(BASEQ3_PATH)) {
    console.error("BASEQ3_PATH no válido o no existe en .env");
    process.exit(1);
}

let mapsCache: any = existsSync(DB_PATH) ? JSON.parse(readFileSync(DB_PATH, 'utf8')) : {};

console.log(`\n=================================================`);
console.log(` Iniciando Escaneo Masivo Síncrono de Mapas .pk3`);
console.log(` Directorio: ${BASEQ3_PATH}`);
console.log(`=================================================\n`);

const pk3Files = readdirSync(BASEQ3_PATH).filter(f => f.endsWith('.pk3'));
let added = 0;
let scanned = 0;

for (const file of pk3Files) {
    const fullPath = path.join(BASEQ3_PATH, file);
    scanned++;
    try {
        const zip = new AdmZip(fullPath);
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

                    // Actualizar siempre en el escaneo masivo manual
                    const shotEntry = zip.getEntries().find(e => e.entryName.toLowerCase() === `levelshots/${technicalName}.jpg`);
                    if (shotEntry) {
                        try { zip.extractEntryTo(shotEntry, PREVIEWS_PATH, false, true); } catch (e) { }
                    }

                    if (!mapsCache[technicalName]) added++;

                    mapsCache[technicalName] = {
                        bsp: technicalName,
                        pk3: file,
                        longname: longMatch ? longMatch[1] : technicalName,
                        type: typeMatch ? typeMatch[1].toLowerCase() : 'unknown',
                        levelshot: shotEntry ? `/previews/${technicalName}.jpg` : null
                    };
                    console.log(`  -> [${file}] ${technicalName} guardado.`);
                }
            }
        }
    } catch (e: any) {
        console.error(`  -> [${file}] Error leyendo PK3:`, e.message);
    }
}

writeFileSync(DB_PATH, JSON.stringify(mapsCache, null, 2));

console.log(`\n=================================================`);
console.log(` Finalizado. Archivos escaneados: ${scanned}`);
console.log(` Mapas nuevos añadidos: ${added}`);
console.log(` Total mapas en DB: ${Object.keys(mapsCache).length}`);
console.log(`=================================================\n`);
