/**
 * Shared branding + HTML helpers for public recipient pages
 * (unsubscribe / email preferences).
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Company logo from LOGO_URL (http/https only). */
export function getLogoUrl(): string | undefined {
  const raw = process.env.LOGO_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function renderLogoHtml(): string {
  const logoUrl = getLogoUrl();
  if (!logoUrl) return "";
  return `<img class="logo" src="${escapeHtml(logoUrl)}" alt="" />`;
}

/** Shared card styles for preference / unsubscribe pages. */
export const PUBLIC_PAGE_STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#f7f7f8; margin:0; padding:24px; color:#1f2328; }
  .card { max-width:420px; margin:40px auto; background:#fff; border-radius:12px; padding:28px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .logo { display:block; max-height:48px; max-width:200px; width:auto; height:auto; margin:0 auto 20px; object-fit:contain; }
  h1 { font-size:18px; margin:0 0 6px; }
  p.sub { color:#6b7280; font-size:13px; margin:0 0 20px; line-height:1.5; }
  .row { display:flex; align-items:flex-start; gap:10px; padding:12px 0; border-bottom:1px solid #eee; cursor:pointer; }
  .row input { width:18px; height:18px; margin-top:2px; flex-shrink:0; }
  .row span { font-size:14px; line-height:1.4; }
  .other-wrap { display:none; margin:8px 0 0 28px; }
  .other-wrap.visible { display:block; }
  .other-wrap input[type="text"] { width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; font-size:14px; }
  button { width:100%; padding:12px; border-radius:8px; border:none; font-size:14px; font-weight:600; cursor:pointer; margin-top:16px; }
  .save { background:#111827; color:#fff; }
  .unsub { background:none; color:#b42318; text-decoration:underline; font-weight:400; padding:8px 0; margin-top:8px; }
  .msg { background:#ecfdf3; color:#027a48; border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px; }
  .err { background:#fef3f2; color:#b42318; border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:16px; }
  .close { background:#e5e7eb; color:#111827; }
  .close-hint { display:none; text-align:center; margin:12px 0 0; }
  .close-hint.visible { display:block; }
`.trim();

/**
 * Try `window.close()`; if the browser blocks it (tabs not opened by script),
 * show a short hint to close manually.
 */
export function renderCloseTabButtonHtml(): string {
  return `<button type="button" class="close" id="close-tab-btn">Close this tab</button>
    <p class="sub close-hint" id="close-tab-hint">Please close this tab manually (Ctrl+W / ⌘W).</p>
    <script>
(function () {
  var btn = document.getElementById("close-tab-btn");
  var hint = document.getElementById("close-tab-hint");
  if (!btn || !hint) return;
  btn.addEventListener("click", function () {
    window.close();
    setTimeout(function () {
      if (!window.closed) {
        btn.style.display = "none";
        hint.classList.add("visible");
      }
    }, 100);
  });
})();
</script>`;
}
