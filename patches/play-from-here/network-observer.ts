/**
 * Observes the HTTP requests Plex Web makes (fetch and XMLHttpRequest)
 * without changing them. This is how the mod learns, with no bundle anchors,
 * which section listing is on screen (with its sort and filters) and which
 * client headers (token, client identifier) Plex Web uses for that server.
 *
 * Tokens are kept in memory only and never logged.
 */
import { extractPlexClientHeaders, parseListingRequest } from "./playqueue";
import type { ListingContext } from "./bindings";

export interface ObservedRequest {
  url: string;
  headers: Record<string, string>;
}

type Win = {
  fetch?: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
  location: { href: string };
};

function headersToRecord(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof (h as Headers).forEach === "function" && !Array.isArray(h)) {
    (h as Headers).forEach((v, k) => (out[k] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h as Array<[string, string]>) out[k] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k] = String(v);
  return out;
}

/** Wraps fetch/XHR on `win`; returns an uninstall function. */
export function installNetworkObserver(win: Win, onRequest: (req: ObservedRequest) => void): () => void {
  const emit = (req: ObservedRequest) => {
    try {
      onRequest(req);
    } catch {
      /* observers must never break Plex Web */
    }
  };
  const undo: Array<() => void> = [];

  const origFetch = win.fetch;
  if (typeof origFetch === "function") {
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      try {
        const isReq = typeof input === "object" && input !== null && "url" in input && !(input instanceof URL);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        const headers = { ...(isReq ? headersToRecord((input as Request).headers) : {}), ...headersToRecord(init?.headers) };
        emit({ url, headers });
      } catch {
        /* ignore */
      }
      return origFetch.call(this, input as RequestInfo, init);
    } as typeof fetch;
    win.fetch = wrapped;
    undo.push(() => {
      if (win.fetch === wrapped) win.fetch = origFetch;
    });
  }

  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const proto = XHR.prototype;
    const { open, setRequestHeader, send } = proto;
    const state = new WeakMap<XMLHttpRequest, ObservedRequest>();
    proto.open = function (this: XMLHttpRequest, ...args: any[]) {
      state.set(this, { url: String(args[1]), headers: {} });
      return (open as any).apply(this, args);
    } as typeof proto.open;
    proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const s = state.get(this);
      if (s) s.headers[name] = value;
      return setRequestHeader.call(this, name, value);
    };
    proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const s = state.get(this);
      if (s) emit(s);
      return send.call(this, body);
    };
    undo.push(() => {
      proto.open = open;
      proto.setRequestHeader = setRequestHeader;
      proto.send = send;
    });
  }

  return () => undo.splice(0).forEach((f) => f());
}

/**
 * Remembers the latest listing per section and the client headers per
 * origin, as seen by the network observer.
 */
export class ListingTracker {
  private readonly bySection = new Map<string, ListingContext>();
  private latest: ListingContext | null = null;
  private readonly headersByOrigin = new Map<string, Record<string, string>>();

  constructor(
    private readonly baseHref: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  observe(req: ObservedRequest): void {
    const base = this.baseHref();
    const h = extractPlexClientHeaders(req.url, req.headers, base);
    if (Object.keys(h).length) {
      try {
        const origin = new URL(req.url, base).origin;
        this.headersByOrigin.set(origin, { ...(this.headersByOrigin.get(origin) ?? {}), ...h });
      } catch {
        /* ignore */
      }
    }
    const l = parseListingRequest(req.url, base);
    if (!l) return;
    const ctx: ListingContext = { ...l, observedAt: this.now() };
    this.bySection.set(`${l.baseUrl}|${l.sectionId}`, ctx);
    this.latest = ctx;
  }

  /**
   * The listing for `sectionId` when given (most recent across servers),
   * otherwise the most recent listing overall.
   */
  current(sectionId?: string): ListingContext | null {
    if (sectionId === undefined) return this.latest;
    let best: ListingContext | null = null;
    for (const l of this.bySection.values()) {
      if (l.sectionId === sectionId && (!best || l.observedAt >= best.observedAt)) best = l;
    }
    return best;
  }

  headersFor(baseUrl: string): Record<string, string> {
    try {
      return { ...(this.headersByOrigin.get(new URL(baseUrl).origin) ?? {}) };
    } catch {
      return {};
    }
  }
}
