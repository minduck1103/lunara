import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, test } from "vitest";
import { act } from "react";
import { readingRequestSchema, rulesVersion, type ReadingRequest } from "../src/data/interpretation";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.defineProperty(window, "matchMedia", { value: () => ({ matches: true }) });

const { createRoot } = await import("react-dom/client");
const { default: App } = await import("../src/App");
const originalFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let requests: ReadingRequest[];

function response(request: ReadingRequest) {
  return {
    rulesVersion, status: "interpreted", overview: "Thông điệp tổng quan của trải bài.",
    cards: request.cards.map((card, index) => ({
      ...card, headline: `Thông điệp lá ${index + 1}`, interpretation: `Nội dung riêng lá ${index + 1}.`,
    })),
    synthesis: "Kết nối của các lá cho thấy bạn có thể cân nhắc một bước nhỏ.",
    advice: ["Dành thời gian suy ngẫm"],
    reflectionQuestion: "Bạn muốn thay đổi điều gì?",
    safetyNote: null,
  };
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  globalThis.fetch = async (_input, init) => {
    const request = readingRequestSchema.parse(JSON.parse(String(init?.body)));
    requests.push(request);
    return Response.json(response(request));
  };
  await act(async () => { root.render(<App />); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  globalThis.fetch = originalFetch;
});

function button(name: string) {
  const found = Array.from(container.querySelectorAll("button")).find((item) =>
    (item.getAttribute("aria-label") ?? item.textContent ?? "").includes(name));
  assert.ok(found, `Missing button: ${name}`);
  return found;
}

function hasButton(name: string) {
  return Array.from(container.querySelectorAll("button")).some((item) => item.textContent?.includes(name));
}

async function click(name: string) {
  await act(async () => {
    button(name).click();
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function draw(count: 1 | 3, reveal = true) {
  await click("Tổng quan");
  await click("Tiếp tục");
  await click(count === 1 ? "Một lá" : "Ba lá");
  await click("Xáo & rút bài");
  if (reveal) await click("Lật tất cả");
}

test("three cards unlock in order, conclusion is explicit, revisiting does not request again", async () => {
  await draw(3, false);
  assert.equal(requests.length, 0);
  assert.equal(hasButton("Bắt đầu giải nghĩa"), false);
  await click("Lật lá bài Quá khứ");
  assert.equal(container.querySelectorAll(".drawn-cards .tarot-card.flipped").length, 1);
  assert.equal(hasButton("Bắt đầu giải nghĩa"), false);
  await click("Lật tất cả");
  assert.equal(container.querySelectorAll(".drawn-cards .tarot-card.flipped").length, 3);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.doesNotMatch(container.textContent ?? "", /\bAI\b|Nghĩa tham khảo có sẵn|Tôi đồng ý/);
  assert.equal(button("Bắt đầu giải nghĩa").disabled, false);
  assert.equal(container.querySelector(".journey-cards"), null);
  assert.equal(hasButton("Kết luận"), false);
  assert.equal(hasButton("Tải ảnh"), false);
  await click("Bắt đầu giải nghĩa");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].cards.length, 3);
  assert.equal(button("Lật lá 1").disabled, false);
  assert.equal(button("Lật lá 2").disabled, true);
  assert.equal(container.querySelectorAll("[data-card-reading]").length, 0);
  await click("Lật lá 1");
  assert.match(container.querySelector("[data-card-reading]:not([hidden])")?.textContent ?? "", /Nội dung riêng lá 1/);
  assert.equal(button("Lật lá 2").disabled, false);
  assert.equal(button("Lật lá 3").disabled, true);
  await click("Lật lá 2");
  assert.equal(container.querySelectorAll("[data-card-reading]:not([hidden])").length, 1);
  await click("Lật lá 3");
  assert.equal(container.querySelectorAll(".journey-cards .tarot-card.flipped").length, 3);
  assert.equal(container.querySelector(".reading-conclusion"), null);
  assert.equal(hasButton("Kết luận"), true);
  await click("Kết luận");
  assert.match(container.querySelector(".reading-conclusion")?.textContent ?? "", /Kết nối của các lá/);
  assert.equal(hasButton("Tải ảnh"), true);
  await click("Xem lại lá 1");
  assert.match(container.querySelector("[data-card-reading]:not([hidden])")?.textContent ?? "", /Nội dung riêng lá 1/);
  assert.equal(container.querySelectorAll("[data-card-reading]").length, 3);
  assert.equal(requests.length, 1);
});

test("one-card spread also requires its flip and conclusion", async () => {
  await draw(1);
  await click("Bắt đầu giải nghĩa");
  assert.equal(requests[0].cards[0].positionId, "message");
  assert.equal(container.querySelectorAll(".journey-cards li").length, 1);
  assert.equal(hasButton("Kết luận"), false);
  await click("Lật lá 1");
  await click("Kết luận");
  assert.equal(hasButton("Tải ảnh"), true);
  await click("Trải bài mới");
  assert.equal(container.querySelector(".reading-conclusion"), null);
  assert.equal(hasButton("Tải ảnh"), false);
});

test("failed requests show neutral errors and retry without fabricated meanings", async () => {
  await draw(3);
  const successFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: "Dịch vụ đang bận. Vui lòng thử lại.", code: "PROVIDER_QUOTA",
  }, { status: 429 });
  await click("Bắt đầu giải nghĩa");
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Dịch vụ đang bận/);
  assert.equal(container.querySelectorAll("[data-card-reading]").length, 0);
  assert.equal(hasButton("Kết luận"), false);
  assert.doesNotMatch(container.textContent ?? "", /\bAI\b/);
  globalThis.fetch = successFetch;
  await click("Thử lại giải nghĩa");
  assert.equal(button("Lật lá 1").disabled, false);
});

test("starting over aborts pending requests and discards late results", async () => {
  await draw(3);
  let resolveResponse: ((response: Response) => void) | undefined;
  let captured: ReadingRequest | undefined;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = readingRequestSchema.parse(JSON.parse(String(init?.body)));
    signal = init?.signal;
    return new Promise((resolve) => { resolveResponse = resolve; });
  };
  await click("Bắt đầu giải nghĩa");
  assert.equal(button("Đang giải nghĩa").disabled, true);
  await click("Trải bài mới");
  assert.equal(signal?.aborted, true);
  assert.ok(captured && resolveResponse);
  const completed = Response.json(response(captured));
  const finish = resolveResponse;
  await act(async () => { finish(completed); });
  assert.equal(container.querySelector(".reading-journey"), null);
  assert.equal(container.querySelector(".reading-conclusion"), null);
});

test("support responses bypass card interpretation and can be saved immediately", async () => {
  await draw(3);
  globalThis.fetch = async (_input, init) => {
    const request = readingRequestSchema.parse(JSON.parse(String(init?.body)));
    return Response.json({
      ...response(request), status: "support", cards: [],
      overview: "Sự an toàn của bạn là điều quan trọng nhất.",
      safetyNote: "Hãy liên hệ người tin cậy để được hỗ trợ.",
    });
  };
  await click("Bắt đầu giải nghĩa");
  assert.match(container.textContent ?? "", /Sự an toàn của bạn/);
  assert.equal(container.querySelector(".journey-cards"), null);
  assert.equal(hasButton("Kết luận"), false);
  assert.equal(hasButton("Tải ảnh"), true);
});
