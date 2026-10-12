import { ConfigurationError } from "./errors.js";

export interface Locale {
  baseUrl: string;
  acceptLanguage: string;
  currency: string;
  countryCode: string;
}

const LOCALES: Record<string, Locale> = {
  "https://www.alza.cz": {
    baseUrl: "https://www.alza.cz",
    acceptLanguage: "cs-CZ,cs;q=0.9,en;q=0.8",
    currency: "CZK",
    countryCode: "CZ",
  },
  "https://www.alza.sk": {
    baseUrl: "https://www.alza.sk",
    acceptLanguage: "sk-SK,sk;q=0.9,en;q=0.8",
    currency: "EUR",
    countryCode: "SK",
  },
  "https://www.alza.hu": {
    baseUrl: "https://www.alza.hu",
    acceptLanguage: "hu-HU,hu;q=0.9,en;q=0.8",
    currency: "HUF",
    countryCode: "HU",
  },
  "https://www.alza.at": {
    baseUrl: "https://www.alza.at",
    acceptLanguage: "de-AT,de;q=0.9,en;q=0.8",
    currency: "EUR",
    countryCode: "AT",
  },
  "https://www.alza.de": {
    baseUrl: "https://www.alza.de",
    acceptLanguage: "de-DE,de;q=0.9,en;q=0.8",
    currency: "EUR",
    countryCode: "DE",
  },
  "https://www.alza.co.uk": {
    baseUrl: "https://www.alza.co.uk",
    acceptLanguage: "en-GB,en;q=0.9",
    currency: "GBP",
    countryCode: "GB",
  },
};

const DEFAULT_BASE_URL = "https://www.alza.cz";

export function resolveLocale(baseUrl?: string): Locale {
  // An empty value means "not set": MCP hosts substitute optional user settings as
  // empty strings (e.g. a cleared `base_url` in the Claude Desktop .mcpb settings).
  const pick = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
  const url = (pick(baseUrl) ?? pick(process.env.ALZA_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const locale = LOCALES[url];
  if (!locale) {
    throw new ConfigurationError(
      `Unsupported ALZA_BASE_URL: ${redactUrl(url)}. Supported: ${Object.keys(LOCALES).join(", ")}`
    );
  }
  return locale;
}

/** The storefront locale whose origin matches `url`, or undefined for any other host
 * (e.g. `m.alza.cz` or a test base). Never throws. */
export function findLocale(url: string): Locale | undefined {
  try {
    return LOCALES[new URL(url).origin];
  } catch {
    return undefined;
  }
}

export function listSupportedLocales(): string[] {
  return Object.keys(LOCALES);
}

/** Origin + path only: never echo userinfo, query or fragment of a configured URL. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 80);
  } catch {
    return "<not a valid URL>";
  }
}
