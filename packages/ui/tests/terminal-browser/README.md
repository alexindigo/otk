# Terminal renderer browser contract

This independent fixture tests the surface's public ports with the pinned WASM
and real Chromium. It does not require the application terminal UI or a native
server. Prepare the repository's existing browser dependencies first.

Run inside the assigned project test guest from its checkout, with disk-backed
`TMPDIR`:

```sh
deno run -A npm:vite@8.2.0 build --config packages/ui/tests/terminal-browser/vite.config.ts --outDir "$PWD/.test-state/terminal-browser"
node tests/browser/terminal-renderer.mjs "$PWD/.test-state/terminal-browser"
```

Expected output is one `passed` JSON record for each of `hidden`, `links` and
`conceal`, then exit 0. An optional third argument is a guest artifact directory
for full screenshots. Hidden checkpoints must match a measured surface, link
activation cannot use a live URI ahead of the painted frame, and a focused block
cursor must not reveal concealed text.
