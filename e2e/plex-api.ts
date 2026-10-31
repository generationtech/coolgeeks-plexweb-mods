/** Minimal PMS API client for assertions (token in headers only). */
import type { APIRequestContext } from "@playwright/test";
import { buildGetPlayQueueRequest, parsePlayQueue, sanitizeListingParams, serializeQuery, type CreatedPlayQueue } from "../patches/play-from-here/playqueue";

export class PlexApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers() {
    return { Accept: "application/json", "X-Plex-Token": this.token, "X-Plex-Client-Identifier": "plexweb-mods-e2e" };
  }

  private async json(url: string): Promise<any> {
    const res = await this.request.get(url, { headers: this.headers() });
    if (!res.ok()) throw new Error(`GET ${new URL(url).pathname}: HTTP ${res.status()}`);
    return res.json();
  }

  async machineIdentifier(): Promise<string> {
    return (await this.json(`${this.baseUrl}/identity`)).MediaContainer.machineIdentifier;
  }

  /** Rating keys of a section listing, in server order, for the given listing params. */
  async listingKeys(sectionId: string, params: URLSearchParams, limit = 500): Promise<string[]> {
    const q = sanitizeListingParams(params);
    q.set("X-Plex-Container-Start", "0");
    q.set("X-Plex-Container-Size", String(limit));
    const body = await this.json(`${this.baseUrl}/library/sections/${sectionId}/all?${serializeQuery(q, true)}`);
    return (body.MediaContainer.Metadata ?? []).map((m: any) => String(m.ratingKey));
  }

  async playQueue(id: string, window = 200): Promise<CreatedPlayQueue> {
    const req = buildGetPlayQueueRequest(this.baseUrl, id, { window, own: true, headers: this.headers() });
    return parsePlayQueue(await this.json(req.url));
  }
}
