import assert from "node:assert/strict";
import { test } from "node:test";
import { queryWithCookies, setGeminiFetchOverrideForTests } from "../gemini-web.ts";

const answer = "Synthetic answer [Source](https://example.com/)";
const candidate = ["wrb.fr", null, JSON.stringify([null, null, null, null, [["candidate", [answer]]]])];
const rejection = ["er", null, null, null, null, [null, null, [[null, [1052]]]]];
const catalog = [["0000000000000001", "Flash", "All-around help", null, null, null, null, null, null, 1, null, "3.8 Flash"],
  ["0000000000000002", "Pro", "Reasoning", null, null, null, null, null, null, 3, null, "3.1 Pro"]];
const status = Array(18).fill(null);
status[15] = catalog; status[16] = [8]; status[17] = [];
const framed = parts => ")]}'\n\n" + parts.map(part => {
  const json = JSON.stringify([part]); return `${json.length + 1}\n${json}\n`;
}).join("");

async function transport(fn, { response = framed([candidate]), statusCode = 200, discovery = status } = {}) {
  const calls = [];
  setGeminiFetchOverrideForTests(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/app")) return new Response('"SNlM0e":"synthetic-test-token"');
    if (String(url).includes("batchexecute")) return new Response(framed([["wrb.fr", "otAQ7b", JSON.stringify(discovery)]]));
    return new Response(response, { status: statusCode });
  });
  try { await fn(calls); } finally { setGeminiFetchOverrideForTests(null); }
}

test("current website names resolve against the account catalog, including the existing default", async () => {
  for (const [model, id, number] of [["gemini-flash", "0000000000000001", 1], ["gemini-3.8-flash", "0000000000000001", 1], ["gemini-3.1-pro", "0000000000000002", 3]]) {
    await transport(async calls => {
      assert.equal(await queryWithCookies("public fixture", {}, { model }), answer);
      assert.equal(calls.length, 3);
      const generation = calls[2].init;
      const header = JSON.parse(generation.headers["x-goog-ext-525001261-jspb"]);
      assert.equal(header[4], id); assert.equal(header[11], 2); assert.equal(header[14], number);
      const inner = JSON.parse(JSON.parse(new URLSearchParams(generation.body).get("f.req"))[1]);
      assert.deepEqual(inner[0], ["public fixture", 0, null, null, null, null, 0]);
      assert.equal(inner[79], number); assert.equal(inner[80], 1);
      assert.match(new URL(calls[2].url).searchParams.get("_reqid"), /^\d{5}$/);
      assert.equal(generation.redirect, "error");
    });
  }
});

test("a retired explicit preset is rejected without a generation request or model substitution", async () => {
  await transport(async calls => {
    await assert.rejects(queryWithCookies("public fixture", {}, { model: "gemini-2.5-flash" }), /not available.*No alternate model/);
    assert.equal(calls.length, 2);
  });
});

test("multiple length-prefixed frames retain text but any later terminal error wins", async () => {
  await transport(async () => assert.equal(await queryWithCookies("public fixture", {}), answer), { response: framed([candidate, candidate]) });
  await transport(async () => assert.rejects(queryWithCookies("public fixture", {}), /code 1052/), { response: framed([candidate, rejection]) });
});

test("length-prefixed frames count the delimiter in UTF-16 units and reject incomplete payloads", async () => {
  const unicodeAnswer = "A public result with an astral symbol 🛰️";
  const unicodeCandidate = ["wrb.fr", null, JSON.stringify([null, null, null, null, [["candidate", [unicodeAnswer]]]])];
  await transport(async () => assert.equal(await queryWithCookies("public fixture", {}), unicodeAnswer), { response: framed([unicodeCandidate]) });

  const partial = JSON.stringify([candidate]);
  await transport(async () => assert.rejects(queryWithCookies("public fixture", {}), error => /incomplete response frame/.test(error.message) && !error.message.includes(answer)), {
    response: `${partial.length + 999}\n${partial}`,
  });
});

test("malformed discovery and truncated terminal frames fail closed without exposing envelopes", async () => {
  await transport(async calls => {
    await assert.rejects(queryWithCookies("public fixture", {}), /model catalog/);
    assert.equal(calls.length, 2);
  }, { discovery: [] });
  await transport(async () => {
    await assert.rejects(queryWithCookies("public fixture", {}), error => /incomplete response frame/.test(error.message) && !error.message.includes(answer));
  }, { response: `${JSON.stringify([candidate]).length + 20}\n${JSON.stringify([candidate])}` });
  await transport(async () => {
    await assert.rejects(queryWithCookies("public fixture", {}), /invalid candidate JSON/);
  }, { response: framed([candidate, ["wrb.fr", null, "private-envelope-marker"]]) });
});

test("a later terminal model rejection wins over an earlier malformed candidate", async () => {
  const malformed = ["wrb.fr", null, "private-envelope-marker"];
  await transport(async () => assert.rejects(queryWithCookies("public fixture", {}), error => /code 1052/.test(error.message) && !error.message.includes("private-envelope-marker")), {
    response: framed([candidate, malformed, rejection]),
  });
});

test("ambiguous model aliases and malformed account flags are rejected before generation", async () => {
  const ambiguous = structuredClone(status);
  ambiguous[15].push(["0000000000000003", "Flash", "Other version", null, null, null, null, null, null, 1, null, "3.9 Flash"]);
  await transport(async calls => {
    await assert.rejects(queryWithCookies("public fixture", {}, { model: "gemini-flash" }), /ambiguous/);
    assert.equal(calls.length, 2);
  }, { discovery: ambiguous });
  const malformed = structuredClone(status); malformed[16] = ["8"];
  await transport(async calls => {
    await assert.rejects(queryWithCookies("public fixture", {}), /model catalog/);
    assert.equal(calls.length, 2);
  }, { discovery: malformed });
});

test("website HTTP failures expose their status for existing routing classification", async () => {
  await transport(async () => assert.rejects(queryWithCookies("public fixture", {}), /Gemini Web HTTP 401/), { statusCode: 401, response: "synthetic refusal" });
});
