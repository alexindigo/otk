// SPDX-License-Identifier: LGPL-3.0-only
import { countLabel, type NotificationHub } from "@otk/client";
/** One favicon owner, counting root-session keys rather than delivery events. */
export function registerBadgeChannel(hub: NotificationHub): () => void {
  const ids = new Set<string>();
  const original = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const icon = original ?? document.createElement("link");
  const href = original?.getAttribute("href"),
    title = original?.getAttribute("title");
  if (!original) {
    icon.rel = "icon";
    document.head.append(icon);
  }
  const paint = () => {
    const style = getComputedStyle(document.documentElement);
    const bg = style.getPropertyValue("--otk-bg").trim(),
      fg = style.getPropertyValue("--otk-fg").trim();
    const attention = style.getPropertyValue("--otk-attention").trim();
    const count = ids.size;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="3" fill="${bg}"/><text x="16" y="22" text-anchor="middle" font-family="monospace" font-size="18" fill="${fg}">O</text>${
        count
          ? `<circle cx="23" cy="9" r="9" fill="${attention}"/><text x="23" y="12" text-anchor="middle" font-family="monospace" font-size="9" fill="${bg}">${
            count > 99 ? "99+" : count
          }</text>`
          : ""
      }</svg>`;
    icon.href = "data:image/svg+xml," + encodeURIComponent(svg);
    icon.title = count
      ? countLabel(count, "session needs attention", "sessions need attention")
      : "OTK";
  };
  const observer = new MutationObserver(paint);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
  paint();
  const release = hub.registerChannel({
    id: "badge",
    available: () => true,
    deliver(note) {
      if (note.sessionRef) {
        ids.add(note.id);
        paint();
      }
    },
    retract(id) {
      ids.delete(id);
      paint();
    },
  });
  return () => {
    release();
    observer.disconnect();
    if (!original) icon.remove();
    else {
      if (href === null) icon.removeAttribute("href");
      else if (href !== undefined) icon.setAttribute("href", href);
      if (title === null) icon.removeAttribute("title");
      else if (title !== undefined) icon.setAttribute("title", title);
    }
  };
}
