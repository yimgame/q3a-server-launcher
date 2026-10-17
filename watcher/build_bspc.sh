#!/usr/bin/env bash
# Compila bspc (github.com/TTimo/bspc) para que el watcher genere los .aas de los bots.
# Uso: bash build_bspc.sh /ruta/a/Quake3      -> deja el binario en /ruta/a/Quake3/tools/bspc-ttimo
# Necesita gcc, make y git (Debian/Ubuntu: apt install build-essential git). Los gcc nuevos tratan como error
# cosas que el código de 1999 hace, por eso se relajan esos avisos.
set -euo pipefail
Q3="${1:-/game}"
TMP="$(mktemp -d)"
git clone -q --depth 1 https://github.com/TTimo/bspc "$TMP/bspc"
make -C "$TMP/bspc" CC="gcc -Wno-error=implicit-function-declaration -Wno-error=incompatible-pointer-types -Wno-error=int-conversion -Wno-error=implicit-int" >/dev/null
mkdir -p "$Q3/tools"
cp "$TMP/bspc/bspc" "$Q3/tools/bspc-ttimo"
rm -rf "$TMP"
"$Q3/tools/bspc-ttimo" 2>&1 | head -2
echo "Listo: $Q3/tools/bspc-ttimo"
