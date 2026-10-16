import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ImpersonateTransport } from "../src/infra/impersonate-transport.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { buildServer } from "../src/server.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { findLocale, resolveLocale } from "../src/infra/locale.js";

// Keep unit tests deterministic: never auto-load a real stored OAuth token.
process.env.ALZA_TOKEN_FILE = "none";

type Seen = { url: string; acceptLanguage: string | null };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function stubFetch(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), acceptLanguage: new Headers(init?.headers).get("accept-language") });
    return json({});
  }) as typeof fetch);
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ALZA_COUNTRY;
  delete process.env.ALZA_CULTURE;
  delete process.env.ALZA_BASE_URL;
});

describe("findLocale", () => {
  it("matches a storefront origin, with or without a path", () => {
    expect(findLocale("https://www.alza.sk")?.countryCode).toBe("SK");
    expect(findLocale("https://www.alza.sk/")?.currency).toBe("EUR");
  });

  it("returns undefined for non-storefront hosts and junk instead of throwing", () => {
    expect(findLocale("https://m.alza.cz")).toBeUndefined();
    expect(findLocale("not a url")).toBeUndefined();
  });
});

describe("MobileApi storefront locale", () => {
  const sk = resolveLocale("https://www.alza.sk");

  it("defaults to CZ for a non-storefront base", () => {
    expect(new MobileApi({ visitorId: "v", baseUrl: "https://test.alza.invalid" }).country).toBe("CZ");
  });

  it("infers the country from a storefront base URL", () => {
    expect(new MobileApi({ visitorId: "v", baseUrl: "https://www.alza.sk" }).country).toBe("SK");
  });

  it("sends the configured country and Accept-Language to the shared webapi/chatbot hosts", async () => {
    const seen = stubFetch();
    const api = new MobileApi({ visitorId: "v", baseUrl: "https://test.alza.invalid", locale: sk });
    await api.whisper("macbook");
    await api.commodityReviews(4463857, { limit: 2 });
    await api.visitorNavigation();
    await api.chatNavigation();
    await api.watchdogList("123");
    await api.userOrder("123", "456");

    expect(seen.map((s) => new URL(s.url).searchParams.get("country"))).toEqual(["SK", "SK", "SK", "SK", "SK", "SK"]);
    // Shared hosts: there is no webapi.alza.sk / chatbotapi.alza.sk.
    expect(seen.slice(0, 4).map((s) => new URL(s.url).host)).toEqual(["webapi.alza.cz", "webapi.alza.cz", "webapi.alza.cz", "chatbotapi.alza.cz"]);
    expect(seen.every((s) => s.acceptLanguage?.startsWith("sk-SK"))).toBe(true);
  });

  it("keeps CZ on every route when no locale is given", async () => {
    const seen = stubFetch();
    const api = new MobileApi({ visitorId: "v", baseUrl: "https://test.alza.invalid" });
    await api.whisper("macbook");
    await api.order2Info();
    expect(seen.map((s) => new URL(s.url).searchParams.get("country"))).toEqual(["CZ", "CZ"]);
    expect(seen[0]?.acceptLanguage).toMatch(/^cs-CZ/);
  });

  it("defaults the chatbot country of MobileAccount to the storefront", async () => {
    const seen = stubFetch();
    const account = new MobileAccount(new MobileApi({ visitorId: "v", baseUrl: "https://test.alza.invalid", locale: sk }));
    await account.chatNavigation();
    await account.chatNavigation("cz");
    expect(seen.map((s) => new URL(s.url).searchParams.get("country"))).toEqual(["SK", "CZ"]);
  });

  it("puts the storefront country and culture on the OAuth authorize URL unless overridden", async () => {
    stubFetch();
    const api = new MobileApi({ visitorId: "v", baseUrl: "https://test.alza.invalid", locale: sk });
    const url = new URL((await api.startOAuth()).authorizationUrl);
    expect(url.searchParams.get("countryCode")).toBe("SK");
    expect(url.searchParams.get("culture")).toBe("sk-SK");

    process.env.ALZA_COUNTRY = "CZ";
    process.env.ALZA_CULTURE = "cs-CZ";
    const overridden = new URL((await api.startOAuth()).authorizationUrl);
    expect(overridden.searchParams.get("countryCode")).toBe("CZ");
    expect(overridden.searchParams.get("culture")).toBe("cs-CZ");
  });

  it("keeps the CZ country on account writes, which are verified on CZ only", async () => {
    const seen = stubFetch();
    const api = new MobileApi({ visitorId: "v", baseUrl: "https://test.alza.invalid", locale: sk });
    await api.setTwoFactor("123", true);
    await api.changePhone("123", "+420123456789");
    await api.changeEmail("123", "a@example.invalid");
    await api.deleteAccount("123");
    await api.watchdogCreate("123", { commodityId: 1, email: "a@example.invalid", isTrackingStock: true, price: null });
    await api.watchdogDelete("123", "w1");
    await api.unlockBasket();
    expect(seen.map((s) => new URL(s.url).searchParams.get("country"))).toEqual(["CZ", "CZ", "CZ", "cz", "CZ", "CZ", "CZ"]);
  });
});

describe("buildServer storefront wiring", () => {
  it("sends the ALZA_BASE_URL storefront's country from the MCP tools", async () => {
    // Set only in the environment, as the CLI does: the browser picks it up, and the
    // MobileApi must get it from the browser (its own base would default to alza.cz).
    process.env.ALZA_BASE_URL = "https://www.alza.sk";
    const seen = stubFetch();
    const built = buildServer({ cfTransport: new ImpersonateTransport({ enabled: false }) });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "locale-wiring", version: "0" });
    try {
      await built.server.connect(s);
      await client.connect(c);
      await client.callTool({ name: "autocomplete", arguments: { query: "macbook" } });
      const whisper = seen.find((r) => r.url.includes("/whisperer/"));
      expect(whisper && new URL(whisper.url).searchParams.get("country")).toBe("SK");
      expect(whisper?.acceptLanguage).toMatch(/^sk-SK/);
    } finally {
      await client.close();
      await built.close();
    }
  });
});
