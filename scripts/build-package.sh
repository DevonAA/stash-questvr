#!/bin/sh
# Build a Stash plugin package source: dist/stable/questvr.zip + dist/stable/index.yml
# (the same format as stashapp's CommunityScripts index). Usage: scripts/build-package.sh [outdir]
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/dist/stable}
SRC=$ROOT/questvr
VERSION=$(sed -n 's/^version: //p' "$SRC/questvr.yml")
DESC=$(sed -n 's/^description: //p' "$SRC/questvr.yml")
NAME=$(sed -n 's/^name: //p' "$SRC/questvr.yml")
COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)
DATE=$(git -C "$ROOT" log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M:%S' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S')
rm -rf "$OUT" && mkdir -p "$OUT"
# deterministic zip (sorted names, fixed timestamps) so an unchanged plugin keeps the same sha256
python3 -I - "$SRC" "$OUT/questvr.zip" <<'PY'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
files = sorted(os.path.relpath(os.path.join(d, f), src) for d, _, fs in os.walk(src) for f in fs)
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    for rel in files:
        info = zipfile.ZipInfo(rel.replace(os.sep, '/'), date_time=(2020, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(src, rel), 'rb') as fh:
            z.writestr(info, fh.read())
PY
SHA=$(sha256sum "$OUT/questvr.zip" | cut -d' ' -f1)
cat > "$OUT/index.yml" <<YML
- id: questvr
  name: $NAME
  metadata:
    description: $DESC
  version: $VERSION-$COMMIT
  date: $DATE
  path: questvr.zip
  sha256: $SHA
YML
echo "built $OUT (questvr $VERSION-$COMMIT)"
