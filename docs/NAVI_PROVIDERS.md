# Navi provider inventory, first pass

Source baseline: `custom` at `fe31a5e`, upstream v0.44.0. The existing `RESOLVED_SEARCH_PROVIDERS` registry in `gemini-search.ts` contains 39 provider IDs. This first pass prioritizes a small test portfolio; it is not a completed audit of all adapters. No owner credential store was inspected and no live service call was made. Operational readiness and live validation are unknown for every candidate below.

Separate four facts: a candidate's purpose, an implemented adapter, a configured credential/endpoint, and a successful live test. An `isAvailable` check often establishes only configuration presence. It cannot prove quota, endpoint reachability, result quality or Chinese coverage. The host must supply current readiness to Navi's policy registry, independently of these research hypotheses.

## Initial portfolio

| Candidate | Role to evaluate | Existing implementation | Credential/configuration reference | Qualification gap |
| --- | --- | --- | --- | --- |
| Brave | General web lookup and freshness controls | `brave.ts`; web search endpoint and recency mapping | `braveApiKey` / `BRAVE_API_KEY`; optional base URL | Live EN/ZH coverage, evidence overlap, limits |
| Exa | Semantic/source discovery and optional content | `exa.ts`; REST `type: auto`, content and filter paths; separate MCP fallback | `exaApiKey` / `EXA_API_KEY`; optional base URL | Measure REST and MCP paths separately; no assumption they have identical coverage or billing |
| Tavily | Search with snippets/raw content and recency controls | `tavily.ts`; basic search, domain/time filters | `tavilyApiKey` / `TAVILY_API_KEY`; optional base URL | Chinese technical retrieval, primary-source coverage and content sufficiency |
| Firecrawl | Content extraction; optional search plus content | `firecrawl.ts`; search and scrape paths | `firecrawlApiKey` / `FIRECRAWL_API_KEY`; configured deployment/base URL | Extraction success and budget accounting separate from search ranking |
| Serper | Additional keyword/SERP comparison | `serper.ts`; recency/domain mapping | `serperApiKey` / `SERPER_API_KEY` | Current official protocol and live readiness audit pending |
| Bocha | Chinese-query candidate | `bocha.ts`; freshness mapping | `bochaApiKey` / `BOCHA_API_KEY` | Current primary docs and measured language advantage pending; candidate role is a hypothesis |
| DuckDuckGo | Keyless resilience comparison | `duckduckgo.ts`; HTML parsing with bot-check handling | No API key in this adapter | Bot challenges, rate limits and live viability; keyless does not imply reliable availability |
| Jev | Decision classification, separate from retrieval | `navi-jev.ts`; new isolated System One adapter | Injected host resolver; no automatic env/config key | Authorized live smoke and bilingual classification evaluation |

Suggested first controlled portfolio: Brave plus Exa for complementary retrieval hypotheses, Tavily as an alternative, and Firecrawl only when content is needed. Keep Serper, Bocha and keyless candidates in the backlog even without keys. Availability may narrow each run, but a missing service remains a recorded skip. No subscriptions are required to exercise offline contracts.

These are experiment candidates, not recommended defaults. Capability diversity is not proof of independent indexes or better answers. The offline runner deliberately uses synthetic provider IDs so this provisional table cannot silently become production routing policy.

## Primary documentation checked

Checked on 2026-10-23 UTC alongside adapter source:

- [Brave web search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started): web-index retrieval. Its separate LLM Context endpoint is not what this repository's current Brave adapter calls.
- [Exa search](https://exa.ai/docs/reference/search): search with typed request options and optional returned content. Existing adapter selects `auto`; do not describe it as forcing a semantic-only mode.
- [Tavily search](https://docs.tavily.com/documentation/api-reference/endpoint/search): search/content options, date/domain and language parameters. A documented vendor parameter is not necessarily exposed by this adapter.
- [Firecrawl search](https://docs.firecrawl.dev/api-reference/endpoint/search): search endpoint and linked scrape interfaces; content work must be accounted for explicitly.
- [TypeSafe System One](https://docs.typesafe.ai/api/system-one): typed decisions, not a retrieval provider. See [adapter notes](NAVI_JEV.md).

Language quality, freshness accuracy, latency and cost require measurements. Do not infer support quality from accepting a Unicode query or from marketing claims. Complete NAV-3 by verifying the remaining primary docs and host readiness in the intended execution environment, then recording sanitized smoke results per provider and route. Never persist key values, private gateway URLs, owner account identities or raw operational evidence in this repository.
