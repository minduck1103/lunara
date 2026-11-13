import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createInterpretHandler } from "../server/interpret";
import { buildSystemInstruction, parseRules } from "../server/rules";
import { parseInterpretation, readingRequestSchema, rulesVersion, type InterpretationResult, type ReadingRequest } from "../src/data/interpretation";

const reading: ReadingRequest = {
  rulesVersion, topic: "general", question: "Mình cần chú ý gì?", spreadId: "one-card",
  cards: [{ cardId: "the-star", positionId: "message", orientation: "reversed" }],
};
const result: InterpretationResult = {
  rulesVersion,
  status: "interpreted",
  overview: "Bạn có thể cần thời gian để nuôi dưỡng lại niềm tin.",
  cards: [{ ...reading.cards[0], headline: "Chăm sóc niềm tin", interpretation: "Ngôi Sao (The Star) ngược gợi ý bạn nên chăm sóc bản thân." }],
  synthesis: "Hãy cho mình thời gian hồi phục thay vì thúc ép.",
  advice: ["Dành thời gian nghỉ ngơi"],
  reflectionQuestion: "Điều gì giúp bạn thấy nhẹ nhõm?",
  safetyNote: null,
};
const env = { GEMINI_API_KEY: "test-key-not-real", GEMINI_MODEL: "gemini-3.6-flash" };
function request(body: unknown = reading, headers: HeadersInit = {}) {
  return new Request("https://lunara.example/api/interpret", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://lunara.example", ...headers },
    body: JSON.stringify(body),
  });
}
function provider(value: unknown = result) {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

test("canonical rule document covers the deck and only selected knowledge enters the prompt", () => {
  const source = readFileSync(join("docs", "11-rule-tarot"), "utf8");
  assert.equal(parseRules(source).cards.size, 78);
  const prompt = buildSystemInstruction(reading);
  assert.match(prompt, /### `the-star`/);
  assert.doesNotMatch(prompt, /### `the-world`/);
  assert.doesNotMatch(prompt, /public\/cards|loadScreenPath|splashPath/);
  assert.match(prompt, /không được suy diễn từ nhân vật/);
  assert.throws(() => parseRules(source.replace("### `the-star`", "### `not-a-card`")));
});

test("request validation rejects substitutions, duplicate draws and wrong positions/counts", () => {
  assert.equal(readingRequestSchema.safeParse(reading).success, true);
  assert.equal(readingRequestSchema.safeParse({ ...reading, cards: [{ ...reading.cards[0], cardId: "unknown" }] }).success, false);
  assert.equal(readingRequestSchema.safeParse({ ...reading, question: "a".repeat(241) }).success, false);
  assert.equal(readingRequestSchema.safeParse({ ...reading, image: "external-image" }).success, false);
  assert.equal(readingRequestSchema.safeParse({ ...reading, cards: [{ ...reading.cards[0], positionId: "past" }] }).success, false);
  const three = {
    ...reading, spreadId: "three-card",
    cards: ["past", "present", "future"].map((positionId) => ({ ...reading.cards[0], positionId })),
  };
  assert.equal(readingRequestSchema.safeParse(three).success, false);
  assert.equal(readingRequestSchema.safeParse({ ...reading, spreadId: "three-card" }).success, false);
});

test("response validation enforces fidelity, length, claims and artwork boundaries", () => {
  assert.deepEqual(parseInterpretation(result, reading), result);
  assert.throws(() => parseInterpretation({ ...result, cards: [{ ...result.cards[0], orientation: "upright" }] }, reading));
  assert.throws(() => parseInterpretation({ ...result, cards: [] }, reading));
  assert.throws(() => parseInterpretation({ ...result, overview: "The World báo hiệu thành tựu." }, reading));
  assert.throws(() => parseInterpretation({ ...result, overview: "Bạn chắc chắn sẽ giàu." }, reading));
  assert.throws(() => parseInterpretation({ ...result, overview: "Hình minh họa gợi ý điều đó." }, reading));
  assert.throws(() => parseInterpretation({ ...result, advice: ["từ ".repeat(27)] }, reading));
});

test("support response stops card interpretation and requires a safety note", () => {
  const support = { ...result, status: "support", cards: [], safetyNote: "Hãy liên hệ người tin cậy hoặc dịch vụ khẩn cấp khi không an toàn." };
  assert.equal(parseInterpretation(support, reading).cards.length, 0);
  assert.throws(() => parseInterpretation({ ...support, safetyNote: null }, reading));
  assert.throws(() => parseInterpretation({ ...support, cards: result.cards }, reading));
});

test("handler sends canonical context to Gemini and returns validated JSON without caching", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), reading);
    assert.ok(body.generationConfig.responseJsonSchema);
    assert.equal(body.generationConfig.maxOutputTokens, 4096);
    assert.match(body.systemInstruction.parts[0].text, /### `the-star`/);
    return provider();
  };
  const response = await createInterpretHandler({ env, fetcher })(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), result);
  assert.equal(calls, 1);
});

test("method, origin, oversized and invalid requests never call the provider", async () => {
  let calls = 0;
  const handler = createInterpretHandler({ env, fetcher: async () => { calls++; return provider(); } });
  assert.equal((await handler(new Request("https://lunara.example/api/interpret"))).status, 405);
  assert.equal((await handler(request(reading, { Origin: "https://attacker.example" }))).status, 403);
  assert.equal((await handler(request({ ...reading, question: "a".repeat(5000) }))).status, 413);
  assert.equal((await handler(request({ ...reading, cards: [] }))).status, 400);
  assert.equal((await handler(request(reading, { "Content-Type": "text/plain" }))).status, 415);
  const broken = new Request("https://lunara.example/api/interpret", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  });
  assert.equal((await handler(broken)).status, 400);
  assert.equal(calls, 0);
});

test("missing configuration returns an explicit 503 rather than simulated AI", async () => {
  const response = await createInterpretHandler({ env: {}, fetcher: async () => { throw new Error("Must not call Gemini"); } })(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "NOT_CONFIGURED");
});

test("invalid AI result is regenerated once and rejected if still invalid", async () => {
  let calls = 0;
  const retry = createInterpretHandler({ env, fetcher: async () => {
    calls++;
    return provider(calls === 1 ? { ...result, cards: [] } : result);
  } });
  assert.equal((await retry(request())).status, 200);
  assert.equal(calls, 2);
  calls = 0;
  const fail = createInterpretHandler({ env, fetcher: async () => {
    calls++;
    return provider({ ...result, cards: [] });
  } });
  const response = await fail(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "INVALID_RESPONSE");
  assert.equal(calls, 2);
});

test("provider quota errors are not retried and provider bodies cannot leak", async () => {
  let calls = 0;
  const handler = createInterpretHandler({ env, fetcher: async () => {
    calls++;
    return Response.json({ error: "private-provider-details" }, { status: 429 });
  } });
  const response = await handler(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.doesNotMatch(await response.text(), /private-provider-details|test-key-not-real/);
  assert.equal(calls, 1);
});

test("provider network failure is explicit", async () => {
  const handler = createInterpretHandler({ env, fetcher: async () => { throw new TypeError("fetch failed"); } });
  const response = await handler(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "PROVIDER_UNAVAILABLE");
});

test("one deadline bounds provider calls", async () => {
  const fetcher: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const response = await createInterpretHandler({ env, fetcher, timeoutMs: 10 })(request());
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "TIMEOUT");
});

test("per-instance rate limits reset after their window", async () => {
  let time = 0;
  const handler = createInterpretHandler({ env, now: () => time, fetcher: async () => provider() });
  for (let index = 0; index < 3; index++) assert.equal((await handler(request())).status, 200);
  assert.equal((await handler(request())).status, 429);
  time = 60_001;
  assert.equal((await handler(request())).status, 200);
});
