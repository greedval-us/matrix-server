#!/bin/sh
set -eu

# Prepare fresh volume roots only; never recursively scan a large index volume.
if [ "$(id -u)" = 0 ]; then
    for directory in config state indexes runtime log; do
        install -d -o manticore -g manticore -m 0755 "$MANTICORE_DATA_DIR/$directory"
    done
    if [ "${1:-}" != searchd ]; then
        install -d -o manticore -g manticore -m 0700 "$MANTICORE_DATA_DIR/private"
    fi
    exec gosu manticore "$0" "$@"
fi

umask 022
if [ "${1:-}" = searchd ] && [ ! -f "$MANTICORE_CONFIG" ]; then
    # Bootstrap only: no database access, credentials or table indexing.
    python3 /app/scripts/build_manticore_indexes.py --bootstrap
fi
exec "$@"
