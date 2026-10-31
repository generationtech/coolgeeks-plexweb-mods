/** Minimal PMS API client for assertions (token in headers only). */
import type { APIRequestContext } from "@playwright/test";
import { buildGetPlayQueueRequest, parsePlayQueue, sanitizeListingParams, serializeQuery, type CreatedPlayQueue } from "../patches/play-from-here/playqueue";

export class PlexApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
    private readonly token: string | undefined,
  ) {}

  private headers() {
    const h: Record<string, string> = { Accept: "application/json", "X-Plex-Client-Identifier": "plexweb-mods-e2e" };
    if (this.token) h["X-Plex-Token"] = this.token;
    return h;
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

  /** Rating keys of a container's children (e.g. a season's episodes), in server order. */
  async childrenKeys(parentRatingKey: string): Promise<string[]> {
    const body = await this.json(`${this.baseUrl}/library/metadata/${parentRatingKey}/children`);
    return (body.MediaContainer.Metadata ?? []).map((m: any) => String(m.ratingKey));
  }

  /** Raw MediaContainer of GET /playQueues/<id> (window omitted = the server's default window). */
  async playQueueRaw(id: string, window?: number): Promise<any> {
    const req = buildGetPlayQueueRequest(this.baseUrl, id, { ...(window !== undefined ? { window } : {}), own: true, headers: this.headers() });
    return (await this.json(req.url)).MediaContainer;
  }

  async playQueue(id: string, window = 200): Promise<CreatedPlayQueue> {
    const req = buildGetPlayQueueRequest(this.baseUrl, id, { window, own: true, headers: this.headers() });
    return parsePlayQueue(await this.json(req.url));
  }
}
