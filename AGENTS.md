# Custom fork workflow

## Branches and reviews

- `origin` is `nextexcite/pi-web-access`; `upstream` is `nicobailon/pi-web-access`.
- `main` stays an exact upstream mirror and the default branch. Sync is manual for now: `git fetch upstream main`, then `git push origin upstream/main:main`. Stop on divergence; never force it or merge customizations into it.
- `custom` is the permanent customized branch. Start short-lived `feat/*`, `fix/*`, `docs/*` or `exp/*` branches from its latest head.
- Open PRs in **this fork**, targeting `custom`: `gh pr create --repo nextexcite/pi-web-access --base custom`. Do not target upstream unless explicitly requested.
- Integrate upstream through a separate sync branch/PR into `custom`, preserving merge ancestry. Do not rebase or force-push published `custom` history.
- Request `@codex review`; address findings and require clean review plus successful CI for the exact head before merging. Check existing PRs before creating duplicates.

## Development and checks

- Inspect `git status` first; preserve unrelated work and untracked evidence. Make the smallest complete change, updating callers, regression tests and docs.
- Record fork changes under `Unreleased` in [CHANGELOG_CUSTOM.md](CHANGELOG_CUSTOM.md); date verified integration milestones. Preserve upstream release history in `CHANGELOG.md`.
- CI uses Node 24; the package requires Node >=22.19. Run `npm run typecheck` and relevant source tests locally. For example:

  ```sh
  node --import ./test/isolate-env.mjs --test --test-skip-pattern='built' test/xai-provider.test.mjs test/x-search.test.mjs test/mcp-server.test.mjs
  git diff --check
  ```

- The full suite includes build-producing tests. Run the full suite and `npm run build` in CI or an explicitly named, approved remote environment, **not on the owner's Mac**. Keep build/release bundles, backup archives and bulk artifacts off the Mac, including temporary folders.
- Offline fixtures are the default. Live search, paid calls, browser sessions and private account access need explicit authorization; report exactly what was tested.
- Never commit credentials, private endpoints, private account identities or raw operational evidence. Reuse existing credential references; keep values out of transcripts and Git.
- Grok registration is not proof of hosted search capability: keep the explicit `xaiResponsesUrl`/key flow and Pi/MCP credential isolation. Preserve URL validation, redaction, redirect rejection and cancellation/timeout behavior; see the README for current settings.

## Delivery and publishing

1. After an approved PR is merged into `custom`, verify CI on the resulting head. Update README and custom history when behavior or configuration changes.
2. When installation updates are requested, use `pi update git:github.com/nextexcite/pi-web-access@custom`. Keep existing standalone MCP checkouts on `custom`, clean before `git pull --ff-only`. Reload Pi/restart the MCP client; source updates do not hot-reload running processes.
3. Normal fork delivery is through Git, not npm. Do not commit/push/merge, migrate owner configuration, update installations, tag or publish without authorization for that operation.
4. `package.json` still names upstream's `pi-web-access`. Never run `npm publish` or `npm run release` as routine fork delivery. A separately requested npm release must confirm a fork-owned name, registry, version and tag first, then build/package/publish in CI or an explicitly named, approved remote environment. Prefer the existing release wrapper and verify `pi.extensions` returns to `./index.ts` even after failure.
