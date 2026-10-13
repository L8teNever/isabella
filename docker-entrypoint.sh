#!/bin/sh
# Version in den Service Worker schreiben -> neue Version = neuer Cache auf den Geraeten
set -e
SRC=/opt/isabella/public
ROOT=/usr/share/nginx/html
V="${APP_VERSION:-dev}"
[ "$V" = "dev" ] && V="dev-$(cat /opt/isabella/build-id)"
rm -rf "$ROOT"/*
cp -a "$SRC"/. "$ROOT"/
sed -i "s/__APP_VERSION__/$V/g" "$ROOT/sw.js"
echo "Isabella Version $V"
