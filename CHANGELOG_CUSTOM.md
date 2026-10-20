# Custom changelog

Fork-only history for [`nextexcite/pi-web-access`](https://github.com/nextexcite/pi-web-access), developed on `custom`. Upstream release notes remain in [CHANGELOG.md](CHANGELOG.md); workflow rules are in [AGENTS.md](AGENTS.md).

Dates identify integration milestones, not separate npm releases. Keep pending changes under **Unreleased**; do not turn planned work or old live observations into current verification claims.

## Unreleased

### Documentation

- Add this custom changelog and concise agent workflow/development/delivery instructions.
- Move fork-specific notes out of the upstream release changelog and link the workflow documents from the README.

## 2026-10-20 — Permanent custom branch and xAI integration

Upstream baseline: **v0.43.0** (`7fcb153`). Reviewed integration: [PR #4](https://github.com/nextexcite/pi-web-access/pull/4), merged as `ac02588`; branch-workflow setup: `28062be`.

### Workflow

- Establish permanent `custom`; retain `main` as the exact upstream mirror and repository default. Upstream sync is manual and fast-forward only for now.
- Use fork-local feature and upstream-sync PRs targeting `custom`; run CI on custom pushes and PRs.
- Move existing Pi and standalone MCP consumers to `custom`. Retire the first xAI feature branch and close superseded PRs #1/#3 after verifying their history is retained.

### Search and compatibility

- Preserve the opt-in dedicated `x_search` tool in Pi and MCP, with native handle/day filters, media understanding off by default, and stored research retrieval. MCP retains its original four tools unless X Search is enabled.
- Adopt upstream's explicit `xaiResponsesUrl` and `xaiApiKey` / `XAI_API_KEY` flow for both interfaces. A registered Grok model does not establish hosted web/X search capability.
- Retire registry-derived `xaiSearchProvider` and duplicate `mcp.xai` routing; legacy settings produce migration errors. Optional `xaiSearchHeaders` preserves explicit gateway routing/diagnostic credential sources.
- Use upstream `xaiSearchTimeoutMs`: 60-second default, positive integer, capped at 10 minutes. A 120-second configuration is a personal starting point, not a universal limit.
- Preserve configured-model authentication for the official xAI route, native web-domain filters, key/header redaction, redirect rejection and caller cancellation. Provider request/body deadlines remain eligible for configured network fallback.
- Reject URL-embedded credentials before authentication, requests or activity logging, without echoing their values.
- Preserve bounded, non-executable optional CPA trace metadata in Pi output, separate from stored/replay data. Document thread/filter limitations rather than promising strict extraction.
- Align canonical configuration documentation for Linkup and `toolNames.xSearch`; retire obsolete registry-route evidence instead of claiming it validates the new route.

### Verification

- Codex review completed clean on `06f074e`; the URL-credential regression failed before its fix and passed afterwards. The focused source suite passed **180 tests** before the subsequent documentation-only update.
- [CI on `28062be`](https://github.com/nextexcite/pi-web-access/actions/runs/39395319776) passed typecheck, the full test suite and build.
- Offline installed-consumer checks passed for Pi extension loading, five-tool MCP discovery with network disabled, and explicit credential-source resolution. No new live search-capability certification was performed.
