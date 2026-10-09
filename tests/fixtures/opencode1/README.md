# opencode 1.x wire fixtures

`sync-envelope.json` is the anonymized durable companion observed during the
overnight 1.18.34 integration run. `stream-lifecycle.json` records real legacy
events from a three-chunk scripted reply in `arch-niri-otk-devbase-otk-m1` on
ark, 2026-10-07. IDs and project paths are anonymized; the event shapes and
ordering are retained, including user text without a streaming time,
authoritative assistant text start, deltas, text completion and message
completion.

`m3-todo-question.json` contains completed tool parts fetched from real opencode
1.18.34 after the R4 checklist/question browser scenario in the same VM. All
four todo states and a question answered through the harness API are recorded.
Source evidence: `m3-prefs-trial1/.test-state/oc-4b4bb3af5f929f61/` under
`/home/tester/otk-commit-check/`. JSON formatting is normalized; field values
are retained.

`m3-basic-tools.json` records real opencode 1.18.34 bash/read/directory-read,
glob/grep/fetch/skill, a local generic plugin, and denied/error tool parts from
the R1/R4/state browser scenarios. The directory read exercises OTK's `list`
search mode. Web-search permission was rejected before its provider call; no
external search was executed. Field values are retained. Source directories:
`/home/tester/otk/.test-state/oc-857b8186062b78de`, `oc-eb9805f340d0520b`,
`oc-c998a5ad36a33442`.
