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
      assert.equal(header[4], id); assert.equal(header[11], 2); assert.equal(header[14], number); assert.equal(header[15], 1);
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

test("conflicting selection tuples fail before upload or generation, while exact duplicates agree", async () => {
  const conflicting = structuredClone(status);
  const duplicate = structuredClone(conflicting[15][0]);
  duplicate[9] = 6;
  conflicting[15].push(duplicate);
  for (const model of ["gemini-flash", "gemini-3.8-flash"]) {
    await transport(async calls => {
      await assert.rejects(queryWithCookies("public fixture", {}, { model, files: [{ path: "/nonexistent-fixture", mimeType: "text/plain" }] }), /conflicting.*model metadata/);
      assert.equal(calls.length, 2);
    }, { discovery: conflicting });
  }
  const exactDuplicate = structuredClone(status);
  exactDuplicate[15].push(structuredClone(exactDuplicate[15][0]));
  await transport(async calls => {
    assert.equal(await queryWithCookies("public fixture", {}, { model: "gemini-flash" }), answer);
    assert.equal(JSON.parse(calls[2].init.headers["x-goog-ext-525001261-jspb"])[14], 1);
  }, { discovery: exactDuplicate });
});

test("model-number precedence follows the pinned schema and invalid metadata fails closed", async () => {
  const primary = structuredClone(status);
  primary[15][0][17] = 6;
  await transport(async calls => {
    await queryWithCookies("public fixture", {}, { model: "gemini-flash" });
    assert.equal(JSON.parse(calls[2].init.headers["x-goog-ext-525001261-jspb"])[14], 6);
    assert.equal(JSON.parse(JSON.parse(new URLSearchParams(calls[2].init.body).get("f.req"))[1])[79], 6);
  }, { discovery: primary });
  for (const number of [undefined, "1", 0, -1, 1.5]) {
    const invalid = structuredClone(status);
    invalid[15][0][9] = number;
    await transport(async calls => {
      await assert.rejects(queryWithCookies("public fixture", {}, { model: "gemini-flash" }), /not available/);
      assert.equal(calls.length, 2);
    }, { discovery: invalid });
  }
});

test("normalized alias collisions and localized-only labels are not guessed", async () => {
  const collision = structuredClone(status);
  collision[15][0][1] = "Flash Lite";
  collision[15][1][1] = " FLASH-LITE ";
  await transport(async calls => {
    await assert.rejects(queryWithCookies("public fixture", {}, { model: "gemini-flash-lite" }), /ambiguous/);
    assert.equal(calls.length, 2);
  }, { discovery: collision });
  const localized = structuredClone(status);
  localized[15] = [["0000000000000001", "快速", null, null, null, null, null, null, null, 1, null, "快速版"]];
  await transport(async calls => {
    await assert.rejects(queryWithCookies("public fixture", {}, { model: "gemini-flash" }), /model catalog/);
    assert.equal(calls.length, 2);
  }, { discovery: localized });
});

test("each call re-resolves IDs and account capacity without reusing another account's selection", async () => {
  const changing = structuredClone(status);
  await transport(async calls => {
    await queryWithCookies("public fixture", { SID: "synthetic-account-A" }, { model: "gemini-flash" });
    changing[15][0][0] = "0000000000000003";
    changing[16] = []; changing[17] = [115];
    await queryWithCookies("public fixture", { SID: "synthetic-account-B" }, { model: "gemini-flash" });
    const first = calls[2].init;
    const second = calls[5].init;
    assert.equal(calls.length, 6);
    assert.equal(JSON.parse(first.headers["x-goog-ext-525001261-jspb"])[4], "0000000000000001");
    assert.equal(JSON.parse(second.headers["x-goog-ext-525001261-jspb"])[4], "0000000000000003");
    assert.equal(JSON.parse(first.headers["x-goog-ext-525001261-jspb"])[11], 2);
    assert.equal(JSON.parse(second.headers["x-goog-ext-525001261-jspb"])[11], 4);
    for (const call of calls.slice(0, 3)) assert.equal(call.init.headers.cookie, "SID=synthetic-account-A");
    for (const call of calls.slice(3)) assert.equal(call.init.headers.cookie, "SID=synthetic-account-B");
  }, { discovery: changing });
});

test("a disappearing version pin fails instead of substituting the surviving category", async () => {
  const changing = structuredClone(status);
  await transport(async calls => {
    await queryWithCookies("public fixture", {}, { model: "gemini-3.8-flash" });
    changing[15][0][11] = "3.9 Flash";
    await assert.rejects(queryWithCookies("public fixture", {}, { model: "gemini-3.8-flash" }), /not available.*No alternate model/);
    assert.equal(calls.length, 5);
    await queryWithCookies("public fixture", {}, { model: "gemini-flash" });
    assert.equal(calls.length, 8);
  }, { discovery: changing });
});

test("website HTTP failures expose their status for existing routing classification", async () => {
  await transport(async () => assert.rejects(queryWithCookies("public fixture", {}), /Gemini Web HTTP 401/), { statusCode: 401, response: "synthetic refusal" });
});
