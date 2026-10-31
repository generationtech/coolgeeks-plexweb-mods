/** Minimal, dependency-free on-page messages (toast + failure banner). */

const STYLE =
  "position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:min(560px,calc(100vw - 32px));" +
  "padding:10px 14px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);";

export function showToast(doc: Document | undefined, message: string, level: "info" | "error" = "info", ttlMs = 6000): void {
  if (!doc?.body) return;
  const el = doc.createElement("div");
  el.setAttribute("data-plexweb-mods-toast", level);
  el.setAttribute("role", level === "error" ? "alert" : "status");
  el.style.cssText = STYLE + (level === "error" ? "background:#5c1a1a;color:#fff;" : "background:#1f2326;color:#fff;");
  el.textContent = message;
  doc.body.appendChild(el);
  setTimeout(() => el.remove(), ttlMs);
}

export function showBanner(doc: Document | undefined, message: string): void {
  if (!doc?.body || doc.querySelector("[data-plexweb-mods-banner]")) return;
  const el = doc.createElement("div");
  el.setAttribute("data-plexweb-mods-banner", "");
  el.setAttribute("role", "alert");
  el.style.cssText = STYLE + "background:#5c1a1a;color:#fff;";
  el.textContent = message + " ";
  const close = doc.createElement("button");
  close.textContent = "Dismiss";
  close.style.cssText = "margin-left:8px;background:none;border:1px solid #fff;color:#fff;border-radius:4px;cursor:pointer;";
  close.addEventListener("click", () => el.remove());
  el.appendChild(close);
  doc.body.appendChild(el);
}
