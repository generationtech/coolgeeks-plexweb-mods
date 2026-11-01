import { buildCreatePlayQueueRequest, parsePlayQueue, itemsFromSelected } from "../../patches/play-from-here/playqueue";
const base = "http://127.0.0.1:32400";
const mid = (await (await fetch(`${base}/identity`, { headers: { Accept: "application/json" } })).json()).MediaContainer.machineIdentifier;
for (const params of ["type=1&sort=year:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=50&includeMeta=1", "type=1&sort=titleSort:desc", "type=1&sort=year:desc&year>>=1999"]) {
  const req = buildCreatePlayQueueRequest({ server: { baseUrl: base, machineIdentifier: mid }, listing: { sectionId: 1, params }, item: { ratingKey: 1 }, headers: { "X-Plex-Client-Identifier": "plexweb-mods-b3" } });
  const res = await fetch(req.url, { method: req.method, headers: req.headers });
  const q = parsePlayQueue(await res.json());
  console.log(params, "->", res.status, "from selected:", itemsFromSelected(q).join(" "));
}
