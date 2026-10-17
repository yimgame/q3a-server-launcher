#!/usr/bin/env python3
"""Carga en caliente nextmap_<modo>.cfg en cada server Q3 y alinea actual/siguiente con el mapa que está corriendo.
Lee la rconpassword de cada cfg (no la imprime). Correr en el host de docker (red host)."""
import re
import socket

BASE = "/q"
import sys
SERVERS = {"ctf": 27964, "tdm": 27963, "ft": 27966, "ra3": 27967, "2v2": 27962, "ca": 27965, "ffa": 27960, "1v1": 27961}
if len(sys.argv) > 1:
    SERVERS = {k: v for k, v in SERVERS.items() if k in sys.argv[1:]}


def rcon(port, pw, cmd):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    s.sendto(b"\xff\xff\xff\xffrcon " + pw.encode() + b" " + cmd.encode(), ("127.0.0.1", port))
    out = b""
    try:
        while True:
            d, _ = s.recvfrom(16384)
            out += d[4:].replace(b"print\n", b"", 1)
    except socket.timeout:
        pass
    return out.decode(errors="replace")


for modo, port in SERVERS.items():
    cfg = open(f"{BASE}/cpma/cfg/yimq3a-cpma-{modo}-server-gemini.cfg", errors="replace").read()
    pw = re.search(r'rconpassword\s+"([^"]+)"', cfg).group(1)
    chain = open(f"{BASE}/cpma/cfg-maps/nextmap_{modo}.cfg", errors="replace").read()
    mapas = [m for _, m in sorted((int(a), b) for a, b in re.findall(r'^set v(\d+) "(?:vstr aca ; )?map (\S+)', chain, re.M))]
    rcon(port, pw, f"exec cfg-maps/nextmap_{modo}.cfg")
    r = rcon(port, pw, "mapname")
    m = re.search(r'"mapname" is:"([^"^]+)', r)
    actual = m.group(1) if m else None
    idx = next((i for i, x in enumerate(mapas) if actual and x.lower() == actual.lower()), None)
    if idx is not None:
        n, sig = len(mapas), f"v{(idx + 1) % len(mapas) + 1}"
        # por rcon el ";" NO separa comandos (va todo como un solo comando): uno por uno
        prev = f"v{(idx - 1) % n + 1}"
        for c in (f"set actual {mapas[idx]}[{idx + 1}/{n}]", f"set mapa_actual {mapas[idx]}",
                  f"set siguiente vstr {sig}", f"set next vstr {sig}", f"set nextmap vstr {sig}",
                  f"set anterior vstr {prev}", f"set prev vstr {prev}", f"set aca set volver vstr v{idx + 1}",
                  f"set volver vstr v{idx + 1}"):
            rcon(port, pw, c)
    else:
        rcon(port, pw, f"set actual {actual}[fuera_de_lista]")
        rcon(port, pw, f"set mapa_actual {actual}")
    vals = [(re.findall(r'is:"([^"]*)"', rcon(port, pw, c)) or ["?"])[0].replace("^7", "") for c in ("actual", "siguiente", "anterior", "aca")]
    print(f"{modo:4} :{port}  corriendo={actual} -> actual={vals[0]} siguiente={vals[1]} anterior={vals[2]} aca={vals[3]}"
          + ("" if idx is not None else "  (mapa fuera de la lista: siguiente = v1)"))
