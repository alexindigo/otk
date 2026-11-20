# Ghostty browser renderer

Vendored from T3 Code (`pingdotgg/t3code`), commit
`7462f234e89027943cf0d1a73d3ae1f36571d4e3`, `apps/web/src/terminal/ghostty/` and
`apps/web/src/terminal-links.ts`. The prebuilt libghostty-vt assets use Ghostty
revision `9f62873bf195e4d8a762d768a1405a5f2f7b1697`. No Zig rebuild is
performed.

T3 and Ghostty are MIT licensed (LICENSE-T3 and LICENSE-GHOSTTY). The bundled
Symbols Nerd Font Mono carries its notice in fonts/LICENSE.

OTK adaptations replace application imports with local helpers, use literal
asset URLs and explicit TypeScript extensions, replace Tailwind with scoped CSS,
and use IBM Plex Mono. Input bytes stay byte-preserving during replay. The
core's PTY writer is permanently a no-op: the daemon answers terminal queries,
while only the surface's keyboard, paste and mouse handlers emit user input. The
client sink bridge lives one directory above in adapter.ts.

Clipboard shortcuts borrow OTK's shared clipboard owner: copy retains its
plain-HTTP fallback and optional programmatic paste reads fall back to native
paste events when unavailable or denied. No secure-only API is read here.
