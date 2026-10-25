# Alpha security findings

These ten CodeRabbit LLM-sourced findings were exported on 2026-10-25 UTC
(2026-10-24 Pacific), against revision
`7a6c542d1d384808d1e6bcee12f8f0b6421a9b4e`. They await triage and fixes for
beta. They have **not been independently verified**; scanner evidence was not
loaded in the export and false positives are possible. Six are medium severity
and four are low; none were reported critical or high.

This is the public summary of the alpha security report. Keep the alpha bound to
`127.0.0.1` with password authentication. Loopback is not a fix for these
reports, including browser-origin attacks.

## 1. WebSocket origin check

**Medium.** A trailing slash in `/api/ws/` may bypass the Origin check applied
to `/api/ws` (`core/auth/middleware.ts`).

## 2. DNS rebinding

**Medium.** The Origin check trusts the request's authority rather than an
independent trusted-host list (`core/auth/middleware.ts`).

## 3. TOTP guessing

**Medium.** Login has no failed-code retry limit or delay
(`core/auth/local.ts`).

## 4. Sparse Markdown tables

**Medium.** Sparse rows expand to a full cell grid and can amplify memory use
(`packages/content/markdown.ts`).

## 5. Markdown emphasis scanning

**Medium.** Unmatched emphasis delimiters may cause quadratic tokenizer CPU work
(`packages/content/markdown.ts`).

## 6. Basic credential forwarding

**Medium.** The exported backend client's path argument may alter the
destination host while retaining Basic credentials
(`packages/harness-opencode1/client.ts`).

## 7. Code layout rescanning

**Low.** Incremental layout repeatedly scans unchanged source
(`packages/ui/components/Code.tsx`).

## 8. Reference regex backtracking

**Low.** Unmatched brackets may cause quadratic work in streaming Markdown
(`packages/content/stream.ts`). The scanner's third-party tokenizer assumption
was not checked.

## 9. Approval projection cost

**Low.** Repeated ancestor and linear-policy searches can amplify browser CPU
work (`packages/protocol/approvals.ts`).

## 10. Framing

**Low.** App HTML lacks frame-ancestor restrictions, allowing potential
clickjacking (`core/http/static.ts`).
