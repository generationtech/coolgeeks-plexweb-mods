#!/bin/sh
# Throwaway, UNCLAIMED Plex Media Server for tests, entirely local:
#   - latest PMS Linux package from plex.tv (SHA-1 verified), extracted, not installed
#   - Preferences: allowedNetworks = localhost only; never claimed, never signed in,
#     no account token anywhere
#   - generated media only (ffmpeg test patterns), in four libraries:
#       "Test Movies"        6 movies, fixed titles/years
#       "Test TV"            1 show, 2 seasons (5 + 3 episodes)
#       "Test Other Videos"  5 clips (Plex Video Files Scanner)
#       "Test Big"           300 movies (hard links to one clip) for play-queue windowing
#
# Usage:
#   scripts/sandbox-pms.sh start     # prints the env vars for reapply.sh / e2e
#   scripts/sandbox-pms.sh stop
#   scripts/sandbox-pms.sh env       # print the env vars again (PMS must be running)
#   scripts/sandbox-pms.sh version   # "<version> <url> <sha1>" of the latest package (cache key)
#
# SANDBOX_DIR (default: $TMPDIR/plexweb-mods-sandbox) holds everything; delete it to reset.
# A valid $SANDBOX_DIR/pms.deb (e.g. restored from a CI cache) is reused, not downloaded.
# Needs: curl, dpkg-deb, ffmpeg, node, sha1sum. Linux x86_64 only.
set -eu

DIR="${SANDBOX_DIR:-${TMPDIR:-/tmp}/plexweb-mods-sandbox}"
PORT=32400
BASE="http://127.0.0.1:$PORT"
PMS_HOME="$DIR/root/usr/lib/plexmediaserver"
SUPPORT="$DIR/support"
HDR_ACCEPT="Accept: application/json"
HDR_CLIENT="X-Plex-Client-Identifier: plexweb-mods-sandbox"
BIG_COUNT=300

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1])??"")})' "$@"; }

webdir() { find "$PMS_HOME/Resources" -path '*WebClient.bundle/Contents/Resources/index.html' | head -1 | xargs dirname; }

latest() {
  curl -fsS https://plex.tv/api/downloads/5.json \
    | json 'const c=v.computer.Linux, r=c.releases.find(r=>r.build==="linux-x86_64"&&r.distro==="debian"); [c.version, r.url, r.checksum].join(" ")'
}

section_id() {
  curl -fsS -H "$HDR_ACCEPT" -H "$HDR_CLIENT" "$BASE/library/sections" \
    | json "(v.MediaContainer.Directory||[]).find(d=>d.title===process.argv[2])?.key" "$1"
}

print_env() {
  echo "export PLEX_URL=$BASE PLEX_INSTALL_TYPE=linux PLEX_WEB_DIR='$(webdir)'" \
    "PLEX_SECTION_ID=$(section_id 'Test Movies')" \
    "PLEX_E2E_TV_SECTION_ID=$(section_id 'Test TV')" \
    "PLEX_E2E_OTHER_SECTION_ID=$(section_id 'Test Other Videos')" \
    "PLEX_E2E_BIG_SECTION_ID=$(section_id 'Test Big')"
}

fetch_package() {
  mkdir -p "$DIR"
  set -- $(latest)
  version=$1 url=$2 sum=$3
  if [ -f "$DIR/root.version" ] && [ "$(cat "$DIR/root.version")" = "$version" ] && [ -x "$PMS_HOME/Plex Media Server" ]; then return; fi
  if ! { [ -f "$DIR/pms.deb" ] && echo "$sum  $DIR/pms.deb" | sha1sum -c --status -; }; then
    echo "sandbox: downloading $(basename "$url")" >&2
    curl -fsS -o "$DIR/pms.deb" "$url"
    echo "$sum  $DIR/pms.deb" | sha1sum -c - >&2
  else
    echo "sandbox: reusing cached package for $version" >&2
  fi
  rm -rf "$DIR/root"
  dpkg-deb -x "$DIR/pms.deb" "$DIR/root"
  echo "$version" > "$DIR/root.version"
}

encode() { # encode <file> <tone-hz> <seconds>
  [ -f "$1" ] && return
  mkdir -p "$(dirname "$1")"
  ffmpeg -loglevel error -y -f lavfi -i "testsrc=size=320x240:rate=24:duration=$3" \
    -f lavfi -i "sine=frequency=$2:duration=$3" \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$1"
}

make_media() {
  m="$DIR/media"
  i=0
  for t in "Alpha Test:2001" "Bravo Test:1995" "Charlie Test:2010" "Delta Test:1987" "Echo Test:2004" "Foxtrot Test:1999"; do
    n=${t%%:*}; y=${t##*:}; i=$((i + 1))
    encode "$m/movies/$n ($y)/$n ($y).mp4" $((300 + i * 100)) 6
  done
  for e in 1 2 3 4 5; do encode "$m/tv/Test Show/Season 01/Test Show - S01E0$e.mp4" $((400 + e * 50)) 6; done
  for e in 1 2 3; do encode "$m/tv/Test Show/Season 02/Test Show - S02E0$e.mp4" $((700 + e * 50)) 6; done
  # PMS merges byte-identical files into one item, so every file must differ.
  i=0
  for c in Kilo Lima Mike November Oscar; do i=$((i + 1)); encode "$m/other/Clip $c.mp4" $((900 + i * 40)) 6; done
  encode "$m/base/big.mp4" 1000 2
  i=1
  while [ $i -le $BIG_COUNT ]; do
    n=$(printf 'Big %03d' $i); y=$((1950 + (i * 37) % 70))
    f="$m/big/$n ($y)/$n ($y).mp4"
    if [ ! -f "$f" ]; then
      mkdir -p "$(dirname "$f")"
      # stream copy + a per-file tag: unique bytes in ~50 ms instead of a re-encode
      ffmpeg -loglevel error -y -i "$m/base/big.mp4" -c copy -metadata "comment=$n" "$f"
    fi
    i=$((i + 1))
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

add_section() { # add_section <title> <type> <agent> <scanner> <dir>
  [ -n "$(section_id "$1")" ] && return
  curl -fsS -o /dev/null -X POST -H "$HDR_ACCEPT" -H "$HDR_CLIENT" --get --data-urlencode "name=$1" \
    --data "type=$2" --data "agent=$3" --data-urlencode "scanner=$4" --data language=xn \
    --data-urlencode "location=$5" "$BASE/library/sections"
}

make_libraries() {
  add_section "Test Movies" movie tv.plex.agents.none "Plex Movie" "$DIR/media/movies"
  add_section "Test TV" show tv.plex.agents.none "Plex TV Series" "$DIR/media/tv"
  # "Other Videos": the Video Files scanner only pairs with the legacy Personal Media agent.
  add_section "Test Other Videos" movie com.plexapp.agents.none "Plex Video Files Scanner" "$DIR/media/other"
  add_section "Test Big" movie tv.plex.agents.none "Plex Movie" "$DIR/media/big"
  # Wait for the scans, then pin titles/years from the folder names
  # ("<Title> (<Year>)") so sorts are deterministic. The scanner's metadata
  # pass can overwrite early edits, so apply, verify, and retry.
  node - "$BASE" "$BIG_COUNT" <<'JS'
const [base, bigCount] = [process.argv[2], Number(process.argv[3])];
const h = { Accept: "application/json", "X-Plex-Client-Identifier": "plexweb-mods-sandbox" };
const get = async (p) => (await (await fetch(base + p, { headers: h })).json()).MediaContainer;
const sections = Object.fromEntries((await get("/library/sections")).Directory.map((d) => [d.title, d.key]));
const want = { "Test Movies": [1, 6], "Test TV": [4, 8], "Test Other Videos": [1, 5], "Test Big": [1, bigCount] };
const pinned = new Set(["Test Movies", "Test Big"]);
for (let attempt = 1; attempt <= 90; attempt++) {
  let ok = true;
  for (const [title, [type, count]] of Object.entries(want)) {
    const id = sections[title];
    const items = (await get(`/library/sections/${id}/all?type=${type}`)).Metadata ?? [];
    if (items.length < count) { ok = false; continue; }
    if (!pinned.has(title)) continue;
    for (const m of items) {
      const folder = String(m.Media?.[0]?.Part?.[0]?.file ?? "").split("/").slice(-2, -1)[0] ?? "";
      const mm = /^(.*) \((\d{4})\)$/.exec(folder);
      if (!mm) { ok = false; continue; }
      if (m.title === mm[1] && m.year === Number(mm[2])) continue;
      ok = false;
      const q = new URLSearchParams({ type: "1", id: String(m.ratingKey), "title.value": mm[1], "title.locked": "1", "year.value": mm[2], "year.locked": "1" });
      await fetch(`${base}/library/sections/${id}/all?${q}`, { method: "PUT", headers: h });
    }
  }
  if (ok) process.exit(0);
  await new Promise((r) => setTimeout(r, 2000));
}
console.error("sandbox: libraries did not settle (scan or title/year pinning)");
process.exit(1);
JS
}

case "${1:-}" in
  start)
    fetch_package; make_media; seed_prefs; start_pms; make_libraries
    echo "sandbox: PMS $(curl -fsS -H "$HDR_ACCEPT" "$BASE/identity" | json 'v.MediaContainer.version') ready (unclaimed, localhost only)" >&2
    print_env
    ;;
  stop)
    if [ -f "$DIR/pms.pid" ]; then kill "$(cat "$DIR/pms.pid")" 2>/dev/null || true; rm -f "$DIR/pms.pid"; fi
    echo "sandbox: stopped" >&2
    ;;
  env) print_env ;;
  version) latest ;;
  *) echo "usage: $0 start|stop|env|version" >&2; exit 2 ;;
esac
