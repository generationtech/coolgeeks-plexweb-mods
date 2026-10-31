#!/bin/sh
# Throwaway, UNCLAIMED Plex Media Server for tests, entirely local:
#   - latest PMS Linux package from plex.tv (SHA-1 verified), extracted, not installed
#   - Preferences: allowedNetworks = localhost only; never claimed, never signed in,
#     no account token anywhere
#   - one movie library of six tiny ffmpeg test videos with fixed titles/years
#
# Usage:
#   scripts/sandbox-pms.sh start    # prints the env vars for reapply.sh / e2e
#   scripts/sandbox-pms.sh stop
#   scripts/sandbox-pms.sh env      # print the env vars again
#
# SANDBOX_DIR (default: $TMPDIR/plexweb-mods-sandbox) holds everything; delete it to reset.
# Needs: curl, dpkg-deb, ffmpeg, node, sha1sum. Linux x86_64 only.
set -eu

DIR="${SANDBOX_DIR:-${TMPDIR:-/tmp}/plexweb-mods-sandbox}"
PORT=32400
BASE="http://127.0.0.1:$PORT"
PMS_HOME="$DIR/root/usr/lib/plexmediaserver"
SUPPORT="$DIR/support"
HDR_ACCEPT="Accept: application/json"
HDR_CLIENT="X-Plex-Client-Identifier: plexweb-mods-sandbox"

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1])??"")})' "$1"; }

webdir() { find "$PMS_HOME/Resources" -path '*WebClient.bundle/Contents/Resources/index.html' | head -1 | xargs dirname; }

print_env() {
  echo "export PLEX_URL=$BASE PLEX_SECTION_ID=1 PLEX_INSTALL_TYPE=linux PLEX_WEB_DIR='$(webdir)'"
}

fetch_package() {
  [ -x "$PMS_HOME/Plex Media Server" ] && return
  mkdir -p "$DIR"
  meta=$(curl -fsS https://plex.tv/api/downloads/5.json)
  url=$(printf '%s' "$meta" | json 'v.computer.Linux.releases.find(r=>r.build==="linux-x86_64"&&r.distro==="debian").url')
  sum=$(printf '%s' "$meta" | json 'v.computer.Linux.releases.find(r=>r.build==="linux-x86_64"&&r.distro==="debian").checksum')
  echo "sandbox: downloading $(basename "$url")" >&2
  curl -fsS -o "$DIR/pms.deb" "$url"
  echo "$sum  $DIR/pms.deb" | sha1sum -c - >&2
  dpkg-deb -x "$DIR/pms.deb" "$DIR/root"
}

make_media() {
  mkdir -p "$DIR/media/movies"
  i=0
  for t in "Alpha Test:2001" "Bravo Test:1995" "Charlie Test:2010" "Delta Test:1987" "Echo Test:2004" "Foxtrot Test:1999"; do
    n=${t%%:*}; y=${t##*:}; i=$((i + 1)); d="$DIR/media/movies/$n ($y)"
    [ -f "$d/$n ($y).mp4" ] && continue
    mkdir -p "$d"
    ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=320x240:rate=24:duration=6" \
      -f lavfi -i "sine=frequency=$((300 + i * 100)):duration=6" \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$d/$n ($y).mp4"
  done
}

seed_prefs() {
  mkdir -p "$SUPPORT/Plex Media Server" "$DIR/tmp"
  p="$SUPPORT/Plex Media Server/Preferences.xml"
  [ -f "$p" ] || cat > "$p" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Preferences allowedNetworks="127.0.0.1/255.255.255.255" AcceptedEULA="1" PublishServerOnPlexOnlineKey="0" FriendlyName="sandbox-test" GdmEnabled="0" />
XML
}

start_pms() {
  if curl -fsS -o /dev/null "$BASE/identity" 2>/dev/null; then echo "sandbox: something already answers on $BASE" >&2; return; fi
  (
    export PLEX_MEDIA_SERVER_APPLICATION_SUPPORT_DIR="$SUPPORT" PLEX_MEDIA_SERVER_HOME="$PMS_HOME" \
      PLEX_MEDIA_SERVER_MAX_PLUGIN_PROCS=2 PLEX_MEDIA_SERVER_INFO_VENDOR=Sandbox PLEX_MEDIA_SERVER_INFO_MODEL=x86_64 \
      PLEX_MEDIA_SERVER_INFO_PLATFORM_VERSION=sandbox TMPDIR="$DIR/tmp" LD_LIBRARY_PATH="$PMS_HOME/lib"
    nohup "$PMS_HOME/Plex Media Server" > "$DIR/pms.log" 2>&1 &
    echo $! > "$DIR/pms.pid"
  )
  for _ in $(seq 1 90); do
    if curl -fsS "$BASE/identity" 2>/dev/null | grep -q 'machineIdentifier' && ! curl -fsS "$BASE/identity" | grep -q startState; then return; fi
    sleep 2
  done
  echo "sandbox: PMS did not become ready; see $DIR/pms.log" >&2
  exit 1
}

make_library() {
  n=$(curl -fsS -H "$HDR_ACCEPT" -H "$HDR_CLIENT" "$BASE/library/sections" | json 'v.MediaContainer.size')
  if [ "$n" = "0" ]; then
    curl -fsS -o /dev/null -X POST -H "$HDR_ACCEPT" -H "$HDR_CLIENT" --get --data-urlencode "name=Test Movies" \
      --data type=movie --data agent=tv.plex.agents.none --data-urlencode "scanner=Plex Movie" --data language=xn \
      --data-urlencode "location=$DIR/media/movies" "$BASE/library/sections"
  fi
  for _ in $(seq 1 60); do
    c=$(curl -fsS -H "$HDR_ACCEPT" -H "$HDR_CLIENT" "$BASE/library/sections/1/all?type=1" | json 'v.MediaContainer.size')
    [ "$c" -ge 6 ] && break
    sleep 2
  done
  # Fixed titles/years so sorts are deterministic. The scanner's own metadata
  # pass can overwrite early edits, so apply, verify, and retry.
  node - "$BASE" <<'JS'
const base = process.argv[2];
const want = { "Alpha Test": 2001, "Bravo Test": 1995, "Charlie Test": 2010, "Delta Test": 1987, "Echo Test": 2004, "Foxtrot Test": 1999 };
const h = { Accept: "application/json", "X-Plex-Client-Identifier": "plexweb-mods-sandbox" };
const list = async () => (await (await fetch(`${base}/library/sections/1/all?type=1`, { headers: h })).json()).MediaContainer.Metadata ?? [];
for (let attempt = 1; attempt <= 15; attempt++) {
  const items = await list();
  let ok = items.length === 6;
  for (const m of items) {
    const name = Object.keys(want).find((n) => String(m.title).startsWith(n));
    if (!name) { ok = false; continue; }
    if (m.title === name && m.year === want[name]) continue;
    ok = false;
    const q = new URLSearchParams({ type: "1", id: String(m.ratingKey), "title.value": name, "title.locked": "1", "year.value": String(want[name]), "year.locked": "1" });
    await fetch(`${base}/library/sections/1/all?${q}`, { method: "PUT", headers: h });
  }
  if (ok) process.exit(0);
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("sandbox: could not settle titles/years");
process.exit(1);
JS
}

case "${1:-}" in
  start)
    fetch_package; make_media; seed_prefs; start_pms; make_library
    echo "sandbox: PMS $(curl -fsS -H "$HDR_ACCEPT" "$BASE/identity" | json 'v.MediaContainer.version') ready (unclaimed, localhost only)" >&2
    print_env
    ;;
  stop)
    if [ -f "$DIR/pms.pid" ]; then kill "$(cat "$DIR/pms.pid")" 2>/dev/null || true; rm -f "$DIR/pms.pid"; fi
    echo "sandbox: stopped" >&2
    ;;
  env) print_env ;;
  *) echo "usage: $0 start|stop|env" >&2; exit 2 ;;
esac
