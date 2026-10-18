# Gemini website configuration evidence and limits

## Contract

The website-only keys `geminiWebModel` and `geminiWebThinking` are passed by `gemini-search.ts` to `queryWithCookies` in `gemini-web.ts`. They never become official Gemini API parameters; `searchModel` remains independent. The API-first fallback order and explicit browser/profile selection are unchanged. Website settings are validated only once the API yields no result or fails and website fallback is attempted; invalid unused website settings cannot break a successful API result. Cookie access remains opt-in.

Only the existing three legacy model presets and default thinking are accepted. Default thinking preserves the existing request bytes rather than selecting a server-side reasoning level. Explicit thinking overrides are rejected, not silently ignored or mapped to an API `thinkingBudget`/`thinkingLevel`.

## Sources inspected

1. This repository at base `18e36f9e0fc2de3c9895a7fda8d39a62ce60f49e`, `gemini-web.ts`: provenance of the three legacy header strings and minimal request body. Keeping them is a regression guarantee, **not** fresh evidence that Google honors the model names today.
2. [HanaokaYuzu/Gemini-API constants.py, commit 1ad0d4a](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/constants.py): website model-selection header construction and model-rejection error codes. The reference warns that static model presets are deprecated.
3. [The same commit, client.py](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/client.py): generation sets body index 80 for standard/extended thinking, mirrors a model number into index 79, and appends thinking/session values to the model header. It also reads error codes from each stream part at `[5][2][0][1][0]`.
4. [The same commit, types/availablemodel.py](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/types/availablemodel.py): model identity, capacity, and model number come from account-specific discovery.

These are public reference implementation observations inspected on 2026-10-18, not an official Google protocol specification, an owned browser capture, or proof of current service behavior. No new IDs, capacity assumptions, headers, or thinking mappings were inferred from them. In particular, adding body index 80 to the legacy request alone would not establish a valid thinking selection.

## Offline fixtures and regression coverage

`test/fixtures/gemini-web-generation.json` is synthetic. It includes legacy model-header expectations, an inert prompt/config, and fabricated candidate text. It contains no cookies, real accounts, captured tokens, or browser data.

`test/gemini-web-generation.test.mjs` checks:

- Exact legacy request/header preservation for every allowed model.
- Model/type validation, unsupported thinking rejection before transport or file reads.
- Search configuration forwarding with a stubbed Brave profile selection.
- Independence of API `searchModel`, cookie opt-in, and website options.
- Candidate/source parsing and latest nonempty text behavior.
- Server model rejection in a later response part, even after partial text, with no retry or alternate model.

The small parser correction prevents a website model-rejection code from being returned as success merely because an earlier part contained text. It does not add a new streaming protocol or model-discovery mechanism.

## Not validated

No live Gemini website request, cookie extraction, Google account selection, subscription entitlement, current model availability, explicit thinking control, or current server acceptance of legacy headers was tested. The adapter cannot prove which model the server actually used from these fixtures. Supporting standard/extended thinking requires account-aware request construction and separately authorized live validation. This patch intentionally fails those requests until that work is done.
