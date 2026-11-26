# Ghostty browser renderer

OTK's Run in terminal writes through one owner (`TerminalRuns` in @otk/client):
a paste gesture through `paste`, then `submit` (Enter) right away, or after the
user confirms. `erase` removes a pending paste. Programmatic writes are marked
so user input can end a pending paste.

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

Checkpoint replacement creates a fresh engine lifetime, including the parser and
UTF-8 decoder; the pinned reset export clears only terminal state. Every new
engine installs the same no-op PTY writer. The PTY grid is applied even to a
hidden surface, independently of viewport measurement. Mouse reports remain
bytes through the surface and input adapter. Link activation is deferred when
the live content revision is ahead of the painted frame. The standalone browser
contract and its guest-only command are in `../../tests/terminal-browser/`.

Temporary WASM buffers are operation-owned and released after both success and
failure, including nested text/byte encoding and query buffers. Published frame
row arrays remain stable across later snapshots. Hover and scroll gestures use
their current painted-row and viewport witnesses. Hiding or disposing a surface
revokes pending clipboard paste intent without stopping its retained output
parser. The scrollbar names the unique accessible output canvas it controls;
terminal cells use physical left alignment independently of surrounding UI
direction.
