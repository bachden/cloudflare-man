import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBrowserRdpGateway, checkStoreEndpoint } from "../src/lib/monitor.js";

test("retries a store endpoint while Cloudflare provisioning settles", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await checkStoreEndpoint("store.example.com", { attempts: 2, retryDelayMs: 0 });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waits for a browser RDP hostname to become an Access endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response("Error 1002", { status: 409 })
      : new Response(null, { status: 302, headers: { Location: "https://example.cloudflareaccess.com/login" } });
  };
  try {
    const result = await checkBrowserRdpGateway("https://rdp.example.com/rdp/vnet/ip/3389", {
      attempts: 2,
      retryDelayMs: 0
    });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 302);
    assert.equal(result.attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
