# Fork update rehearsal

Delivery is through `nextexcite/pi-web-access:custom`, not upstream npm. This
runbook is a manual rehearsal of a future watch → integrate → verify → deliver
→ notify workflow. It does not install a watcher or authorize unattended updates.
[AGENTS.md](../AGENTS.md) owns the review and workstation-storage rules.

## 1. Discover and pin upstream

- Inspect local status and preserve unrelated work, including untracked evidence.
- Check existing fork PRs before opening another sync PR.
- Read the latest upstream release and inspect its actual diff. Fetch its tag and
  `upstream/main`; record the release tag and exact commit being integrated.
- Confirm `origin/main` is an ancestor of `upstream/main` before a mirror push.
  Stop on divergence; never force the mirror or merge custom code into it.

## 2. Reapply the customization through Git ancestry

Create a short-lived sync branch from the latest `origin/custom` and merge the
pinned upstream release with a merge commit. The customization is the maintained
Git history, not a second opaque patch archive. Git reapplies non-conflicting
changes; conflicts require inspection rather than automatic preference for
`ours` or `theirs`. Do not rebase or force-push published `custom` history.

Preserve the dedicated X Search behavior, Pi/MCP credential isolation and tool
activation tests. Keep upstream release history in `CHANGELOG.md` and fork
changes in `CHANGELOG_CUSTOM.md`. Keep gateway integration configuration-only;
do not add a KeyPool provider, extension retries or telemetry as part of this sync.

## 3. Verify before delivery

Run typecheck, relevant source tests and `git diff --check` locally. Include the
KeyPool configuration fixture, new upstream gateway/activation tests and the
fork's X Search/MCP regressions. Never run the full suite or a build on the
owner's Mac: build-producing checks belong in the existing GitHub CI job. Run
source checks with an empty temporary `PI_CODING_AGENT_DIR` so owner routing does
not change tests that expect provider defaults; the test preload isolates the
cache but does not hide the owner's configuration.

Live verification is a separate, explicitly authorized gate:

- Reuse an existing scoped caller credential reference; never load admin inputs.
- Use the real extension adapter/core with explicit `exa`, `tavily` and
  `firecrawl` selections so another provider cannot hide a failure.
- Bound the requests and result counts. Check the provider, result/error shape
  and destination/header mapping, not merely the command exit status.
- Verify Firecrawl extraction separately if it is in the approved scope. Do not
  silently enable fresh scraping or broaden SSRF ranges to pass a smoke test.
- Keep owner defaults and unrelated configuration unchanged. Gateway settings
  alone do not authorize changes to provider priority or hosted fetch routing.
- Return only value-free pass/fail receipts, request counts, source refs and
  limitations. Do not commit private endpoints, identities or raw responses.

## 4. Review and publish through the fork

1. Commit/push the sync branch and open a fork-local PR targeting `custom`.
2. Request `@codex review`. Address findings and require clean review plus
   successful CI for the exact final PR head. New commits invalidate old gates.
3. Merge only with owner authorization. Preserve the upstream merge ancestry.
4. Check CI again on the resulting `custom` head. Mirror upstream `main` only
   by a separately authorized fast-forward push. Never run `npm publish` or
   `npm run release` for ordinary fork delivery.

Conflicts, failed checks, unavailable review, authentication errors and unknown
mutation outcomes stop the affected gate. Never turn a skipped gate into success.

## 5. Update consumers and notify the owner

For an authorized installation update:

```sh
pi update git:github.com/nextexcite/pi-web-access@custom
```

Require clean standalone MCP checkouts on `custom` before `git pull --ff-only`.
Do not build bundles locally. Apply only the approved configuration delta using
existing credential references; preserve other keys, scopes and defaults. Verify
the installed checkout ref and actual adapter/host behavior rather than assuming
source publication updated a running client. Reload Pi or restart the MCP client;
running processes do not hot-reload source/configuration changes automatically.

Notify the owner with:

- upstream release, fork PR and delivered merge SHA;
- exact-head review/CI and resulting-head CI links;
- source, configuration, installation and live-verification gates separately;
- providers checked, request counts, preserved defaults and any untested behavior;
- required reload/restart, rollback instructions and any blocker.

A future automatic watcher may prepare the same PR and notification. Its schedule,
credentials, merge/update authority and failure notifications require a separate
explicit rollout; this rehearsal does not grant them.
