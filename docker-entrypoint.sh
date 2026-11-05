#!/bin/sh
# Startet als root, sorgt dafür, dass DATA_DIR dem Benutzer node gehört, und
# startet den Server dann ohne Root-Rechte (su-exec).
# Hintergrund: Ein Bind-Mount wie ./data:/data überdeckt das im Image vorbereitete
# /data. Legt Docker ./data beim ersten Start selbst an, gehört der Ordner root:root
# und node (UID 1000) dürfte nichts darin anlegen.
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Nur anfassen, was nicht schon node gehört (schnell auch bei vielen Dateien).
  if [ -n "$(find "$DATA_DIR" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    echo "Setze Besitzer von $DATA_DIR auf node (UID $(id -u node))"
    find "$DATA_DIR" \( ! -user node -o ! -group node \) -exec chown node:node {} + \
      || echo "Warnung: Besitzer von $DATA_DIR ließ sich nicht ändern (z. B. NFS mit root_squash). Bitte auf dem Host: chown -R $(id -u node):$(id -g node) <Datenordner>" >&2
  fi
  exec su-exec node "$@"
fi

exec "$@"
