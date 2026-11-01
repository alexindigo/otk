# Browser test tooling

This private Node island owns Playwright Test and its TypeScript check. It does
not import Deno runtime helpers or product implementation paths. Deno continues
to own the application build and existing tests. Tooling acceptance lives only
under `tooling/`, selected by `playwright.tooling.config.ts`; ordinary browser
configs must select their own test directories.

Run preparation and verification only inside the assigned OTK test VM, from
`/home/tester/otk`, with this disk-backed environment:

```sh
export PATH=/opt/otk-test/node/bin:/home/tester/.deno/bin:/usr/local/bin:/usr/bin
export TMPDIR=/home/tester/otk/tmp
export PLAYWRIGHT_BROWSERS_PATH=/opt/otk-test/ms-playwright
npm --prefix tests/browser ci
npm --prefix tests/browser exec -- playwright install chromium
npm --prefix tests/browser run check
npm --prefix tests/browser run acceptance:tooling
```

Node 24.22.2 (npm 11.19.1), Deno 2.9.6 and the exact dependencies in
`package.json` are the preparation contract. Use Playwright's matching managed
Chromium, preserving stock Chromium for the Deno consumers. On Arch, install
needed native libraries/fonts with pacman, not `playwright install-deps`.
Prepare each native version's provider cache through the existing
`tests/support/prepare-provider-cache.ts`, selecting `OTK_TEST_OPENCODE` and
`OTK_TEST_PROVIDER_CACHE` per version. Never use real provider credentials.

Provisioning records `.test-state/provisioning/toolchain.json` with schema 1,
guest UUID, tool versions, source URLs, archive/executable SHA-256 hashes,
installed pacman package versions, fonts, managed browser revision and paths,
and per-version native executable/cache paths. Preserve it with source manifests
and verification logs before sealing a base. Missing exact artifacts or an
incompatible platform block preparation rather than changing pins.

Acceptance observes a trusted button click at an accessible counter, Unicode
input readback and nonzero viewport-centered geometry. It writes the
observations, full screenshot and runner report under
`tests/browser/test-results/` in the guest workspace; these are evidence, never
committed source.
