#!/usr/bin/env python3
"""Regenera cpma/cfg-maps/nextmap_<modo>.cfg con alias de rotación manual para todos los servers Q3.

Respeta la lista y el orden de la cadena actual (set vN "map X ; ...") y agrega a cada vN:
  actual     -> "mapa[N/total]"   (/rcon actual  = en qué mapa y número estás)
  mapa_actual-> "mapa"            (lo lee el watcher de CTF para saber si el salto fue manual)
  siguiente / next / nextmap -> "vstr vN+1"   (/rcon vstr siguiente  = pasar al próximo)
  anterior / prev  -> "vstr vN-1"  (el anterior EN LA LISTA)
  volver           -> el mapa en el que estabas antes del último salto: cada vN primero ejecuta "vstr aca"
                      (que deja volver apuntando al mapa actual) y recién después cambia y actualiza "aca"
El valor inicial sale del "map X" del cfg del server (el mapa con el que arranca).
Uso: python3 generar_nextmap.py /ruta/a/Quake3
"""
import re
import sys

BASE = sys.argv[1] if len(sys.argv) > 1 else "/q"
MODOS = ["ctf", "tdm", "1v1", "2v2", "ffa", "ca", "ft", "ra3"]
V_RE = re.compile(r'^\s*set\s+v(\d+)\s+"(?:vstr aca ; )?map\s+(\S+)')


def mapa_inicial(modo):
    try:
        for linea in open(f"{BASE}/cpma/cfg/yimq3a-cpma-{modo}-server-gemini.cfg", errors="replace"):
            m = re.match(r"^\s*map\s+(\S+)", linea)
            if m:
                return m.group(1)
    except FileNotFoundError:
        pass
    return None


for modo in MODOS:
    ruta = f"{BASE}/cpma/cfg-maps/nextmap_{modo}.cfg"
    mapas = sorted(((int(m.group(1)), m.group(2)) for m in map(V_RE.match, open(ruta, errors="replace")) if m))
    mapas = [x for _, x in mapas]
    n = len(mapas)
    sig = lambda i: f"v{i % n + 1}"
    ant = lambda i: f"v{(i - 2) % n + 1}"
    out = [f"// Rotación manual (vstr chain) para {modo.upper()} -- {n} mapas, generado por generar_nextmap.py",
           "// /rcon vstr siguiente   (o next / nextmap)  -> pasa al próximo mapa de la lista",
           "// /rcon actual                               -> en qué mapa y número estás, ej. basesiege[1/42]",
           "// /rcon vstr v7                              -> salta directo al mapa número 7",
           "// /rcon vstr volver                          -> vuelve al mapa de antes del último salto",
           "// /rcon vstr anterior   (o prev)             -> el anterior en la lista",
           ""]
    for i, mp in enumerate(mapas, 1):
        out.append(f'set v{i} "vstr aca ; map {mp} ; set actual {mp}[{i}/{n}] ; set mapa_actual {mp} ; '
                   f'set siguiente vstr {sig(i)} ; set next vstr {sig(i)} ; set nextmap vstr {sig(i)} ; '
                   f'set anterior vstr {ant(i)} ; set prev vstr {ant(i)} ; set aca set volver vstr v{i}"')
    ini = mapa_inicial(modo)
    i0 = mapas.index(ini) + 1 if ini in mapas else 0
    out += ["",
            f"// arranque: el server inicia en {ini or '?'}" + ("" if i0 else " (no está en la lista: el próximo es v1)"),
            f'set actual "{ini}[{i0}/{n}]"' if i0 else f'set actual "{ini or "?"}"',
            f'set mapa_actual "{ini or ""}"',
            f'set siguiente "vstr {sig(i0) if i0 else "v1"}"',
            f'set next "vstr {sig(i0) if i0 else "v1"}"',
            f'set nextmap "vstr {sig(i0) if i0 else "v1"}"',
            f'set anterior "vstr {ant(i0) if i0 else "v" + str(n)}"',
            f'set prev "vstr {ant(i0) if i0 else "v" + str(n)}"',
            f'set aca "set volver vstr v{i0}"' if i0 else 'set aca ""',
            f'set volver "vstr v{i0 if i0 else 1}"', ""]
    open(ruta, "w").write("\n".join(out))
    print(f"{modo}: {n} mapas, arranca en {ini} (#{i0})")
