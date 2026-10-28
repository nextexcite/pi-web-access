import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const xaiUrl = new URL("../xai-search.ts", import.meta.url).href;
const indexUrl = new URL("../index.ts", import.meta.url).href;
const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const success = {
	status: "completed",
	output: [{ type: "message", content: [{ type: "output_text", text: "A thread can include older posts.", annotations: [
		{ type: "url_citation", url: "https://x.com/jack/status/20", title: "Thread", start_index: 0, end_index: 8 },
	] }] }],
};
const register = `
const tools = new Map(), handlers = new Map(); let active = [];
const { default: initialize } = await import(${JSON.stringify(indexUrl)});
initialize({
 registerTool(tool) { tools.set(tool.name, tool); active.push(tool.name); },
 registerCommand() {}, registerShortcut() {}, appendEntry() {},
 on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => {}; },
 getAllTools() { return [...tools.values()]; }, getActiveTools() { return active; }, setActiveTools(names) { active = names; },
});
`;
function run(body, config = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-x-search-test-"));
	writeFileSync(join(home, "web-search.json"), JSON.stringify({ xaiApiKey: "test-xai-key", ...config }));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: body, encoding: "utf8", timeout: 15_000,
		env: { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), XAI_API_KEY: "", PI_WEB_ACCESS_CACHE_ROOT: join(home, "cache") },
	});
	rmSync(home, { recursive: true, force: true });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("dedicated X requests use native per-call fields and X auth without changing concurrent web search", () => {
	const out = run(`
 const bodies = [];
 globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(${JSON.stringify(success)}); };
 const { searchX, searchWithXai } = await import(${JSON.stringify(xaiUrl)});
 const ctx = { modelRegistry: {
  find(provider,id) { return { id, api:"openai-responses", baseUrl:"https://api.x.ai/v1" }; },
  async getApiKeyAndHeaders() { return { ok:true, apiKey:"registry-key" }; },
 } };
 const result = await Promise.all([
  searchX({query:"X query",allowed_x_handles:["NASA"],from_date:"2024-02-29",to_date:"2024-03-01",enable_video_understanding:true}, undefined, ctx),
  searchWithXai("Web query",{},ctx),
  searchWithXai("Overridden web query",{model:"custom-web-model"},ctx),
 ]);
 console.log(JSON.stringify({bodies,result}));
 `, { xaiSearchTools: ["web_search"] });
	const x = out.bodies.find(body => body.model === "grok-4.6");
	const web = out.bodies.find(body => body.model === "grok-4.5");
	assert.deepEqual(x.tools, [{ type: "x_search", allowed_x_handles: ["NASA"], from_date: "2024-02-29", to_date: "2024-03-01", enable_image_understanding: false, enable_video_understanding: true }]);
	assert.deepEqual(web.tools, [{ type: "web_search" }]);
	assert.deepEqual(out.bodies.find(body => body.model === "custom-web-model").tools, web.tools);
	assert.deepEqual(Object.keys(x).sort(), ["input", "model", "tools"]);
	assert.match(x.input, /Search X/);
	assert.match(web.input, /Search the web/);
	assert.equal(out.result[0].results[0].url, "https://x.com/jack/status/20", "Do not prune thread evidence under an unchanged answer");
});

test("dedicated X validates every field before resolving credentials or fetching", () => {
	const out = run(`
 let credentials=0, fetches=0;
 const ctx={modelRegistry:{find(){credentials++;throw new Error("must not resolve credentials");}}};
 globalThis.fetch=async()=>{fetches++;throw new Error("must not fetch");};
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 const bad=[null,[],{}, {query:" "},{query:1},
  {query:"q",max_results:1},{query:"q",provider:"xai"},{query:"q",queries:["q"]},
  {query:"q",allowed_x_handles:[]},{query:"q",allowed_x_handles:["@NASA"]},
  {query:"q",allowed_x_handles:["bad handle"]},{query:"q",allowed_x_handles:["a".repeat(16)]},
  {query:"q",allowed_x_handles:Array.from({length:21},(_,i)=>"h"+i)},
  {query:"q",allowed_x_handles:["NASA","nasa"]},
  {query:"q",allowed_x_handles:["NASA"],excluded_x_handles:["SpaceX"]},
  {query:"q",excluded_x_handles:null},{query:"q",excluded_x_handles:[]},
  {query:"q",excluded_x_handles:Array.from({length:21},(_,i)=>"h"+i)},
  {query:"q",from_date:"2024-02-30"},
  {query:"q",from_date:"2023-02-29"},{query:"q",from_date:"0000-01-01"},
  {query:"q",from_date:"2024-01-01T00:00:00Z"},{query:"q",to_date:"2024-13-01"},
  {query:"q",from_date:"2024-03-01",to_date:"2024-03-01"},
  {query:"q",from_date:"2024-03-02",to_date:"2024-03-01"},
  {query:"q",enable_image_understanding:"true"},{query:"q",enable_video_understanding:1}];
 const errors=[];
 for(const params of bad){try{await searchX(params,undefined,ctx);errors.push(null);}catch(e){errors.push(e.message);}}
 console.log(JSON.stringify({credentials,fetches,errors}));
 `, { xaiResponsesUrl: "https://proxy.example.test/v1/responses" });
	assert.equal(out.credentials, 0);
	assert.equal(out.fetches, 0);
	assert.ok(out.errors.every(error => typeof error === "string" && error.startsWith("x_search")));
});

test("dedicated X ignores global tool selection and uses only the explicitly configured gateway", () => {
	const out = run(`
 let captured;
 globalThis.fetch=async(url,init)=>{captured={url,body:JSON.parse(init.body),headers:Object.fromEntries(init.headers),redirect:init.redirect};return Response.json(${JSON.stringify(success)});};
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 const lookups=[];
 const ctx={modelRegistry:{find(provider,id){lookups.push([provider,id]);throw new Error("explicit gateways must not query Pi providers");}}};
 await searchX({query:"q",excluded_x_handles:["SpaceX"]},undefined,ctx);
 console.log(JSON.stringify({captured,lookups}));
 `, { xaiResponsesUrl: "https://proxy.example.test/v1/responses", xaiApiKey: "gateway-key", xaiSearchModel: "grok-4.7", xaiSearchHeaders: { "X-Extra": "extra" }, xaiSearchTools: [] });
	assert.deepEqual(out.lookups, []);
	assert.equal(out.captured.url, "https://proxy.example.test/v1/responses");
	assert.equal(out.captured.redirect, "error");
	assert.equal(out.captured.headers.authorization, "Bearer gateway-key");
	assert.equal(out.captured.headers["x-extra"], "extra");
	assert.deepEqual(out.captured.body.tools, [{ type: "x_search", excluded_x_handles: ["SpaceX"], enable_image_understanding: false, enable_video_understanding: false }]);
});

test("dedicated X refuses incomplete, failed and missing completion status", () => {
	const out = run(`
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 const errors=[];
 for(const status of ["incomplete","failed",undefined]){
  globalThis.fetch=async()=>Response.json({...${JSON.stringify(success)},status});
  try{await searchX({query:"q"});errors.push(null);}catch(e){errors.push(e.message);}
 }
 console.log(JSON.stringify(errors));
 `);
	assert.ok(out.every(error => /complet/i.test(error ?? "")));
});

test("opted-in X tool returns bounded structured research with retrievable unchanged evidence", () => {
	const out = run(`
 import {Value} from "typebox/value";
 let requests=0;
 globalThis.fetch=async()=>{requests++;return Response.json({...${JSON.stringify(success)},output:[{type:"message",content:[{type:"output_text",text:"A".repeat(4000),annotations:${JSON.stringify(success.output[0].content[0].annotations)}}]}]});};
 ${register}
 const tool=tools.get("x_search");
 const result=await tool.execute("x",{query:"research",allowed_x_handles:["NASA"]});
 const stored=await tools.get("get_search_content").execute("stored",{responseId:result.structuredContent.responseId,queryIndex:0});
 console.log(JSON.stringify({names:[...tools.keys()],requests,result,stored,valid:Value.Check(tool.outputSchema,result.structuredContent)}));
 `, { tools: { xSearch: { enabled: true } }, maxInlineContentChars: 1000 });
	assert.equal(out.requests, 1);
	assert.ok(out.names.includes("x_search"));
	assert.notEqual(out.result.isError, true);
	assert.equal(out.valid, true);
	assert.equal(out.result.structuredContent.fetchId, null);
	assert.equal(out.result.structuredContent.queries[0].provider, "xai");
	assert.match(out.result.structuredContent.limitations, /thread/i);
	assert.match(out.result.content[0].text, /thread/i);
	assert.ok(out.result.content[0].text.length <= 1000);
	assert.equal(out.result.structuredContent.queries[0].answer.length, 4000);
	assert.match(out.stored.content[0].text, /A{500}/);
	assert.equal(out.result.structuredContent.queries[0].results[0].url, "https://x.com/jack/status/20");
});

test("X tool failures are marked with a structured envelope and preserve real cancellation", () => {
	const out = run(`
 ${register}
 const tool=tools.get("x_search");
 const invalid=await tool.execute("invalid",{query:"q",max_results:1});
 const controller=new AbortController(), reason=new DOMException("user stopped","AbortError");
 globalThis.fetch=async(_url,init)=>{controller.abort(reason);throw init.signal.reason;};
 let same=false;try{await tool.execute("cancel",{query:"q"},controller.signal);}catch(e){same=e===reason;}
 console.log(JSON.stringify({invalid,same}));
 `, { tools: { xSearch: { enabled: true } } });
	assert.equal(out.invalid.isError, true);
	assert.match(out.invalid.structuredContent.queries[0].error, /max_results/);
	assert.match(out.invalid.structuredContent.limitations, /thread/i);
	assert.equal(out.same, true);
});

test("registry credential waits preserve caller cancellation without late fetches or fallbacks", () => {
	for (const key of [undefined, "explicit-key"]) {
		const out = run(`
 import {getEventListeners} from "node:events";
 const {searchX,searchWithXai,resolveXaiAuth}=await import(${JSON.stringify(xaiUrl)});
 ${register}
 let unhandled=0;process.on("unhandledRejection",()=>unhandled++);
 const results=[];
 for(const kind of ["x","web","auth","tool"])for(const late of ["resolve","reject"]){
  const caller=new AbortController(),reason=new DOMException("operator cancelled credentials","AbortError");
  let resolve,reject,finds=0,keys=0,fetches=0;
  const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const ctx={modelRegistry:{
   find(_provider,id){finds++;return {id,api:"openai-responses",baseUrl:"https://api.x.ai/v1"};},
   getApiKeyAndHeaders(){keys++;queueMicrotask(()=>caller.abort(reason));return pending;},
  }};
  globalThis.fetch=async()=>{fetches++;throw new Error("must not fetch");};
  const request=kind==="x"?searchX({query:"q"},caller.signal,ctx):kind==="web"?searchWithXai("q",{signal:caller.signal},ctx):kind==="auth"?resolveXaiAuth(ctx,caller.signal):tools.get("x_search").execute("blocked",{query:"q"},caller.signal,undefined,ctx);
  let timer;
  const outcome=await Promise.race([request.then(()=>({returned:true}),error=>({sameReason:error===reason})),new Promise(done=>{timer=setTimeout(()=>done({hung:true}),100);})]);
  clearTimeout(timer);
  if(late==="resolve")resolve({ok:true,apiKey:"registry-key"});else reject(new Error("late credential failure"));
  await new Promise(setImmediate);
  results.push({outcome,finds,keys,fetches,listeners:getEventListeners(caller.signal,"abort").length});
 }
 console.log(JSON.stringify({results,unhandled}));
 `, { xaiApiKey: key, tools: { xSearch: { enabled: true } } });
		assert.equal(out.results.length, 8);
		for (const result of out.results) assert.deepEqual(result, { outcome: { sameReason: true }, finds: 1, keys: 1, fetches: 0, listeners: 0 });
		assert.equal(out.unhandled, 0);
	}
});

test("pre-aborted calls and post-auth cancellation never send registry credentials", () => {
	for (const key of [undefined, "explicit-key"]) {
		const out = run(`
 const {searchX,searchWithXai,resolveXaiAuth}=await import(${JSON.stringify(xaiUrl)});
 const results=[];
 for(const [kind,stage] of [["x","pre"],["web","pre"],["auth","pre"],["x","post"],["web","post"]]){
  const caller=new AbortController(),reason=new DOMException("operator cancelled","AbortError");if(stage==="pre")caller.abort(reason);
  let finds=0,keys=0,fetches=0;
  const ctx={modelRegistry:{find(_provider,id){finds++;return {id,api:"openai-responses",baseUrl:"https://api.x.ai/v1"};},async getApiKeyAndHeaders(){keys++;return {ok:true,apiKey:"registry-key",get headers(){caller.abort(reason);return {};}};}}};
  globalThis.fetch=async()=>{fetches++;throw new Error("must not fetch");};
  let sameReason=false;
  try{if(kind==="x")await searchX({query:"q"},caller.signal,ctx);else if(kind==="web")await searchWithXai("q",{signal:caller.signal},ctx);else await resolveXaiAuth(ctx,caller.signal);}catch(error){sameReason=error===reason;}
  results.push({stage,sameReason,finds,keys,fetches});
 }
 console.log(JSON.stringify(results));
 `, { xaiApiKey: key });
		for (const result of out) {
			const expectedLookups = result.stage === "pre" ? 0 : 1;
			assert.deepEqual(result, { stage: result.stage, sameReason: true, finds: expectedLookups, keys: expectedLookups, fetches: 0 });
		}
	}
});

test("X tool respects provider exclusion even when called through the shared core", () => {
	const out = run(`
 const {createWebToolCore,DEFAULT_TOOL_NAMES}=await import(${JSON.stringify(coreUrl)});
 let requests=0;globalThis.fetch=async()=>{requests++;throw new Error("must not fetch");};
 const core=createWebToolCore({settings:{toolNames:DEFAULT_TOOL_NAMES,enabledTools:{xSearch:true},maxInlineContentChars:1000,fetchModes:{defaultMode:"readable",allowedModes:["readable"]}},storeFetchedContent(){}});
 const result=await core.xSearch({query:"q"});
 console.log(JSON.stringify({result,requests}));
 `, { webSearch: { allowedProviders: ["brave"] } });
	assert.equal(out.requests, 0);
	assert.match(out.result.structuredContent.queries[0].error, /not allowed|disallowed|allowedProviders/i);
});

test("dedicated X accepts 20 allowed or excluded handles and explicitly enables images", () => {
	const bodies = run(`
 const bodies=[];globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(init.body));return Response.json(${JSON.stringify(success)});};
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 for(const key of ["allowed_x_handles","excluded_x_handles"])await searchX({query:"q",[key]:Array.from({length:20},(_,i)=>"h"+i),enable_image_understanding:true});
 console.log(JSON.stringify(bodies));
 `);
	assert.equal(bodies[0].tools[0].allowed_x_handles.length, 20);
	assert.equal(bodies[1].tools[0].excluded_x_handles.length, 20);
	for (const body of bodies) assert.equal(body.tools[0].enable_image_understanding, true);
});

test("dedicated X requires an explicit gateway key and redacts configured key/header secrets", () => {
	const missing = run(`
 let requests=0;globalThis.fetch=async()=>{requests++;throw new Error("must not fetch");};
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 let error;try{await searchX({query:"q"},undefined,{modelRegistry:{find(){return undefined;}}});}catch(e){error=e.message;}
 console.log(JSON.stringify({requests,error}));
 `, { xaiResponsesUrl: "https://proxy.example.test/v1/responses", xaiApiKey: undefined });
	assert.equal(missing.requests, 0);
	assert.match(missing.error, /xaiResponsesUrl is set/);
	const denied = run(`
 globalThis.fetch=async()=>new Response("denied gateway-secret header-secret",{status:401});
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 const ctx={modelRegistry:{find(){throw new Error("explicit gateways must not query Pi providers");}}};
 let error;try{await searchX({query:"q"},undefined,ctx);}catch(e){error=e.message;}
 console.log(JSON.stringify(error));
 `, { xaiResponsesUrl: "https://proxy.example.test/v1/responses", xaiApiKey: "gateway-secret", xaiSearchHeaders: { "X-Secret": "header-secret" } });
	assert.match(denied, /401/);
	assert.doesNotMatch(denied, /gateway-secret|header-secret/);
	assert.match(denied, /redacted/);
});

test("dedicated X provider deadline is an error result, not caller cancellation", () => {
	const out = run(`
 const deadline=new AbortController();let timeoutMs;
 AbortSignal.timeout=ms=>{timeoutMs=ms;return deadline.signal;};
 globalThis.fetch=async()=>{deadline.abort(new DOMException("The operation was aborted due to timeout","TimeoutError"));throw deadline.signal.reason;};
 ${register}
 const result=await tools.get("x_search").execute("deadline",{query:"q"});
 console.log(JSON.stringify({result,timeoutMs}));
 `, { tools: { xSearch: { enabled: true } }, xaiSearchTimeoutMs: 120000 });
	assert.equal(out.timeoutMs, 120000);
	assert.equal(out.result.isError, true);
	assert.match(out.result.structuredContent.queries[0].error, /timed out after 120 seconds/);
});

test("dedicated X applies configured gateway deadlines through response reading and caps them", () => {
	for (const [configured, expected] of [[300000, 300000], [900000, 600000]]) {
		const out = run(`
 const deadline=new AbortController();let timeoutMs;
 AbortSignal.timeout=ms=>{timeoutMs=ms;return deadline.signal;};
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>{deadline.abort(new DOMException("The operation was aborted due to timeout","TimeoutError"));throw deadline.signal.reason;}});
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 let error;try{await searchX({query:"q"});}catch(e){error=e.message;}
 console.log(JSON.stringify({error,timeoutMs}));
 `, { xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiSearchTimeoutMs: configured });
		assert.equal(out.timeoutMs, expected);
		assert.equal(out.error, `xAI search timed out after ${expected / 1000} seconds`);
	}
});

test("X deferred exposure and renamed retrieval remain configured, not silently bypassed", () => {
	const out = run(`
 ${register}
 const x=tools.get("research_x");
 const unknown=await tools.get("open_content").execute("missing",{responseId:"missing"});
 console.log(JSON.stringify({exposure:x.exposure,description:x.description,unknown,loader:tools.get("web_enable").promptSnippet}));
 `, {
		toolExposure: "deferred", toolNames: { xSearch: "research_x", getSearchContent: "open_content" },
		tools: { xSearch: { enabled: true }, webSearch: { enabled: false }, sourceCheck: { enabled: false }, fetchContent: { enabled: false } },
	});
	assert.equal(out.exposure, "deferred");
	assert.match(out.description, /open_content/);
	assert.match(out.loader, /X social research/);
	assert.match(out.unknown.content[0].text, /research_x/);
	assert.doesNotMatch(out.unknown.content[0].text, /web_search|source_check/);
});

test("CPA terminal trace remains allowlisted non-executable output, never tools or replay input", () => {
	const trace = { version: 1, executable: false, observed_only: true, availability: "observed", truncated: false, activities: [
		{ ordinal: 1, operation: "x_keyword_search", status: "completed" },
	] };
	const out = run(`
 import {Value} from "typebox/value";
 const {getResult}=await import(new URL("./storage.ts",${JSON.stringify(indexUrl)}).href);
 const trace=${JSON.stringify(trace)};
 globalThis.fetch=async()=>Response.json({... ${JSON.stringify(success)},x_cpa_x_search_trace:{...trace,private_id:"must-not-leak",activities:[{...trace.activities[0],arguments:"must-not-leak",call_id:"must-not-leak"}]}});
 ${register}
 const result=await tools.get("x_search").execute("trace",{query:"q"});
 const stored=getResult(result.structuredContent.responseId);
 console.log(JSON.stringify({result,names:[...tools.keys()],stored,valid:Value.Check(tools.get("x_search").outputSchema,result.structuredContent)}));
 `, { tools: { xSearch: { enabled: true } } });
	assert.deepEqual(out.result.structuredContent.x_cpa_x_search_trace, trace);
	assert.equal(out.valid, true);
	assert.ok(!out.names.includes("x_keyword_search"));
	assert.doesNotMatch(JSON.stringify(out), /must-not-leak/);
	assert.doesNotMatch(JSON.stringify(out.stored), /x_cpa_x_search_trace/);
});

test("CPA absent or malformed trace is not invented, and not-observed stays distinct from zero calls", () => {
	const out = run(`
 const {searchX,searchWithXai}=await import(${JSON.stringify(xaiUrl)});
 const base={version:1,executable:false,observed_only:true,availability:"not_observed",truncated:false,activities:[]};
 const results=[];
 for(const trace of [undefined,{...base,executable:true},{...base,availability:"observed"}, {...base,version:2}, {...base,activities:Array(129).fill({ordinal:1,operation:"x_keyword_search",status:"completed"})},base]){
  globalThis.fetch=async()=>Response.json({... ${JSON.stringify(success)},x_cpa_x_search_trace:trace});
  results.push((await searchX({query:"q"})).x_cpa_x_search_trace??null);
 }
 globalThis.fetch=async()=>Response.json({... ${JSON.stringify(success)},x_cpa_x_search_trace:base});
 const web=await searchWithXai("q");
 console.log(JSON.stringify({results,webTrace:web.x_cpa_x_search_trace??null}));
 `);
	assert.deepEqual(out.results.slice(0, 5), Array(5).fill(null));
	assert.equal(out.results[5].availability, "not_observed");
	assert.deepEqual(out.results[5].activities, []);
	assert.equal(out.webTrace, null);
});

test("standalone MCP X Search follows the explicit tool opt-in", () => {
	const body = `const {createStandaloneWebToolCore}=await import(${JSON.stringify(coreUrl)});console.log(JSON.stringify(createStandaloneWebToolCore().enabledToolNames));`;
	assert.deepEqual(run(body), ["web_search", "source_check", "fetch_content", "get_search_content"]);
	assert.deepEqual(run(body, { tools: { xSearch: { enabled: true } } }), ["x_search", "web_search", "source_check", "fetch_content", "get_search_content"]);
});

test("explicit search endpoint and credentials are shared by Pi and standalone MCP", () => {
	const out = run(`
 process.env.SEARCH_TEST_KEY="gateway-key";process.env.SEARCH_TEST_ROUTE="gateway-route";
 let lookups=0;
 const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,headers:Object.fromEntries(init.headers),body:JSON.parse(init.body),redirect:init.redirect});return Response.json(${JSON.stringify(success)});};
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 const ctx={modelRegistry:{find(){lookups++;throw new Error("must not borrow Pi auth");}}};
 await searchX({query:"standalone",enable_image_understanding:true});
 await searchX({query:"Pi"},undefined,ctx);
 console.log(JSON.stringify({calls,lookups}));
 `, { xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiApiKey: "$SEARCH_TEST_KEY", xaiSearchModel: "grok/custom", xaiSearchHeaders: { "X-Aigw-Model": "$SEARCH_TEST_ROUTE", authorization: "stale", "content-type": "stale", "X-Removed": null } });
	assert.equal(out.lookups, 0);
	for (const call of out.calls) {
		assert.equal(call.url, "https://gateway.example.test/v1/responses");
		assert.equal(call.headers.authorization, "Bearer gateway-key");
		assert.equal(call.headers["x-aigw-model"], "gateway-route");
		assert.equal(call.headers["content-type"], "application/json");
		assert.equal(call.headers["x-removed"], undefined);
		assert.equal(call.body.model, "grok/custom");
		assert.equal(call.redirect, "error");
	}
	assert.deepEqual(out.calls[0].body.tools, [{ type: "x_search", enable_image_understanding: true, enable_video_understanding: false }]);
});

test("explicit gateway header configuration fails closed before fetching or key fallback", () => {
	for (const config of [
		{ xaiSearchHeaders: {} },
		{ xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiSearchHeaders: [] },
		{ xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiSearchHeaders: { "bad name": "!must-not-run" } },
		{ xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiSearchHeaders: { "X-Route": 42 } },
		{ xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiSearchHeaders: { "X-Route": "route-secret\nvalue" } },
		{ xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiSearchHeaders: { "X-Route": "$SEARCH_MISSING_TEST_HEADER" } },
		{ xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiApiKey: "key-secret\nvalue" },
	]) {
		const out = run(`
 let requests=0;globalThis.fetch=async()=>{requests++;throw new Error("must not fetch");};
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 let error;try{await searchX({query:"q"});}catch(e){error=e.message;}
 console.log(JSON.stringify({requests,error}));
 `, config);
		assert.equal(out.requests, 0);
		assert.match(out.error, /xaiSearchHeaders|xaiApiKey|credential resolution/);
		assert.doesNotMatch(out.error, /test-xai-key|route-secret|key-secret/);
	}
});

test("explicit gateway availability does not execute key or header commands", () => {
	const available = run(`const {isXaiSearchAvailable}=await import(${JSON.stringify(xaiUrl)});console.log(JSON.stringify(await isXaiSearchAvailable({modelRegistry:{find(){throw new Error("must not resolve Pi");}}})));`, { xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiApiKey: "!must-not-run", xaiSearchHeaders: { "X-Route": "!must-not-run" } });
	assert.equal(available, true);
});

test("explicit gateway errors redact resolved credentials and preserve auth cancellation", () => {
	const out = run(`
 const {searchX}=await import(${JSON.stringify(xaiUrl)});
 globalThis.fetch=async()=>new Response("denied gateway-secret route-secret",{status:401});
 let error;try{await searchX({query:"q"});}catch(e){error=e.message;}
 const caller=new AbortController(),reason=new DOMException("cancelled gateway auth","AbortError");let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error("must not fetch");};
 const pending=searchX({query:"q"},caller.signal);queueMicrotask(()=>caller.abort(reason));
 let same=false;try{await pending;}catch(e){same=e===reason;}
 console.log(JSON.stringify({error,same,requests}));
 `, { xaiResponsesUrl: "https://gateway.example.test/v1/responses", xaiApiKey: "gateway-secret", xaiSearchHeaders: { "X-Route": "route-secret" } });
	assert.match(out.error, /401/);
	assert.doesNotMatch(out.error, /gateway-secret|route-secret/);
	assert.equal(out.same, true);
	assert.equal(out.requests, 0);
});
