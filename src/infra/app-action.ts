import { URL } from "node:url";

export type AppActionMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AppActionRel = "self" | "collection" | "form" | "create-form" | "edit-form" | "multipart";

export interface AppActionMeta {
  href: string;
  method?: string | null;
  rel?: AppActionRel[] | null;
}

export interface AppActionValue {
  name: string;
  value: unknown;
  kind?: "text" | "integer" | "boolean" | "decimal" | "text-array" | "integer-array";
}

export interface AppActionFilePart {
  /** Form field name for the file part (from the server-provided form values). */
  partName: string;
  fileName: string;
  /** Whitelisted image MIME type. */
  mimeType: string;
  /** `data:<mime>;base64,....` payload. */
  dataUrl: string;
}

export interface AppActionForm {
  meta: AppActionMeta;
  values?: AppActionValue[];
}

export interface ServerAppAction {
  appLink?: string;
  form: AppActionForm;
  enabled?: boolean;
}

/** Minimal fetch contract: the global fetch satisfies it, and so does the
 * Chrome-fingerprint sidecar adapter (CfResponseAdapter). */
export interface FetchLikeResponse {
  status: number;
  ok: boolean;
  headers: {
    get(name: string): string | null;
    getSetCookie?(): string[];
  };
  text(): Promise<string>;
}
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<FetchLikeResponse>;

export interface AppActionExecutorOptions {
  baseUrl: string;
  visitorId: string;
  userId?: number;
  authorizationToken?: string;
  userAgent?: string;
  /** Storefront Accept-Language (default Czech). */
  acceptLanguage?: string;
  allowedPathPrefixes?: string[];
  fetchImpl?: FetchLike;
}

export interface ExecuteAppActionOptions {
  allowMutation?: boolean;
  confirmationToken?: string;
  /** Typed user-input values merged into the server-provided form values (user values win on name conflict). */
  extraValues?: AppActionValue[];
  /** Multipart file parts (only for `multipart` rel actions). */
  files?: AppActionFilePart[];
  /** Route family + method allowlist of the calling tool (issues #61/#62).
   * Checked against the action href and every redirect target. */
  routePolicy?: AppActionRoutePolicy;
}

/** Per-tool AppAction route policy: the decoded, lower-cased request path must
 * match one of `pathPatterns`, and the resolved method must be in `methods`. */
export interface AppActionRoutePolicy {
  readonly family: string;
  readonly pathPatterns: readonly RegExp[];
  readonly methods: readonly AppActionMethod[];
}

/** Route policies of the typed AppAction tools. The hrefs are server-provided
 * (source-confirmed families, mostly not live-captured), so each family is a
 * keyword match on the path; readers are GET-only, writers POST-only. */
export const APP_ACTION_ROUTE_POLICIES = {
  addressWrite: { family: "address", pathPatterns: [/address/], methods: ["POST"] },
  addressSearch: { family: "address search", pathPatterns: [/address/], methods: ["GET"] },
  reviewWrite: { family: "review", pathPatterns: [/review|rating/], methods: ["POST"] },
  claimsRead: { family: "warranty claim / complaint", pathPatterns: [/claim|complaint/], methods: ["GET"] },
  subscriptionRead: { family: "subscription", pathPatterns: [/subscription/], methods: ["GET"] },
  subscriptionWrite: { family: "subscription", pathPatterns: [/subscription|installment/], methods: ["POST"] },
  attachmentUpload: { family: "attachment", pathPatterns: [/attachment|upload|image|claim|complaint/], methods: ["POST"] },
} as const satisfies Record<string, AppActionRoutePolicy>;

/** Routes the executor never calls, whatever the tool or token (issues #61/#62):
 * GET-shaped writes that have their own token-gated tools (coupons, basket,
 * order services, discussion ratings, checkout steps), and credential, payment,
 * order-submission, account-identity and device routes. */
const DENIED_ROUTES: RegExp[] = [
  /\/(?:addcoupon|delcoupon|updbasket|unlockbasket|addorderservice|ratecommoditydiscussionposts|approveorder\d*|sendorder\d*|orderfinished|afterorderpayment|createafterpayment|createuser|gdprinformation|cancellations|pushdevice)(?:\/|$)/,
  /\/(?:account|useraccount)\/password(?:\/|$)/,
  /\/(?:2fa|second-factor)(?:\/|$)/,
  /\/v\d+\/account\/?$/,
];

const ALLOWED_FILE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/bmp", "image/avif"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const DEFAULT_PATH_PREFIXES = ["/api/", "/services/restservice.svc/"];
const SAFE_METHODS = new Set<AppActionMethod>(["GET", "POST"]);

function relHasMultipart(meta: AppActionMeta): boolean {
  return (meta.rel ?? []).includes("multipart");
}
const MUTATING_METHODS = new Set<AppActionMethod>(["POST", "PUT", "PATCH", "DELETE"]);
/** Sensitive field names, matched as case-insensitive substrings so camelCase
 * names (`oldPassword`, `password1`, `paymentId`, `cardId`, `refreshToken`,
 * `ibanNumber`) are caught too (issue #61). `bic` is too short for a substring
 * match, so it is matched as a whole name segment. */
const BLOCKED_FIELD_SUBSTRING = /passw|pwd|secret|token|authori[sz]ation|cookie|refresh|card|cvv|cvc|iban|payment|encrypted/i;
const BLOCKED_FIELD_SEGMENTS = new Set(["bic"]);

export function isSensitiveFieldName(name: string): boolean {
  if (BLOCKED_FIELD_SUBSTRING.test(name)) return true;
  const segments = name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/);
  return segments.some((segment) => BLOCKED_FIELD_SEGMENTS.has(segment));
}

export class AppActionExecutor {
  private readonly fetchImpl: FetchLike;
  private readonly origin: string;
  private readonly pathPrefixes: string[];
  private readonly cookies = new Map<string, string>();

  constructor(private readonly options: AppActionExecutorOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "https:") throw new Error("AppAction base URL must use HTTPS");
    this.origin = base.origin;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pathPrefixes = options.allowedPathPrefixes ?? DEFAULT_PATH_PREFIXES;
    if (this.pathPrefixes.length === 0 || this.pathPrefixes.some((p) => !p.startsWith("/"))) {
      throw new Error("AppAction path allowlist is invalid");
    }
  }

  async execute(action: ServerAppAction, options: ExecuteAppActionOptions = {}): Promise<unknown> {
    if (!action || !action.form || !action.form.meta) throw new Error("AppAction form metadata is required");
    if (action.enabled === false) throw new Error("AppAction is disabled");

    let target = this.validateTarget(action.form.meta.href, options.routePolicy);
    const method = this.resolveMethod(action.form.meta);
    if (options.routePolicy && !options.routePolicy.methods.includes(method)) {
      throw new Error(`AppAction method ${method} is not allowed for this tool (${options.routePolicy.family} actions allow ${options.routePolicy.methods.join("/")})`);
    }
    const values = this.normalizedValues([
      ...(action.form.values ?? []),
      { name: "visitorId", value: this.options.visitorId, kind: "text" as const },
      ...(this.options.userId === undefined ? [] : [{ name: "userId", value: this.options.userId, kind: "integer" as const }]),
      ...(options.extraValues ?? []),
    ]);
    if (options.files && options.files.length > 0 && !relHasMultipart(action.form.meta)) {
      throw new Error("File parts require a multipart AppAction (meta.rel must include 'multipart')");
    }
    const hasMutation = MUTATING_METHODS.has(method);
    if (hasMutation && (!options.allowMutation || !options.confirmationToken)) {
      throw new Error("AppAction mutation requires explicit confirmation");
    }

    const isMultipart = relHasMultipart(action.form.meta);
    const init: RequestInit = { method, redirect: "manual", headers: this.headers(isMultipart) };

    if (method === "GET") {
      target = this.addQuery(target, values);
    } else if (isMultipart) {
      init.body = this.multipartBody(values, options.files ?? []);
      (init.headers as Headers).delete("content-type");
    } else {
      init.body = JSON.stringify(this.jsonBody(values));
    }

    let response = await this.requestWithCookies(target, init);
    for (let redirectCount = 0; response.status >= 300 && response.status < 400 && redirectCount < 3; redirectCount += 1) {
      const location = response.headers.get("location");
      if (!location) throw new Error("AppAction redirect has no location");
      target = this.validateTarget(location, options.routePolicy);
      if (method !== "GET") throw new Error("AppAction mutation redirects are blocked");
      response = await this.requestWithCookies(target, { ...init, method: "GET", body: undefined });
    }
    if (response.status >= 300 && response.status < 400) throw new Error("AppAction redirect limit exceeded");
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`AppAction ${method} ${new URL(target).pathname} failed with HTTP ${response.status}`);
    return body;
  }

  private validateTarget(href: string, policy?: AppActionRoutePolicy): string {
    if (!href || typeof href !== "string") throw new Error("AppAction href is required");
    const target = new URL(href, this.origin);
    if (target.protocol !== "https:" || target.origin !== this.origin) throw new Error("AppAction href is outside the allowed origin");
    if (!this.pathPrefixes.some((prefix) => target.pathname.startsWith(prefix))) throw new Error("AppAction path is outside the allowlist");
    let path: string;
    try { path = decodeURIComponent(target.pathname).toLowerCase(); } catch { throw new Error("AppAction path is not valid percent-encoding"); }
    // Path forms a server may route differently from the plain path the
    // denylist and family checks see: `;` path parameters, encoded slashes,
    // control characters, and segments with a trailing dot or whitespace
    // (e.g. `/afterOrderPayment;address`, `/account/password.`). Fail closed.
    if (/%2f|%5c/i.test(target.pathname) || /[;\\\x00-\x1f\x7f]/.test(path) || /[.\s](?:\/|$)/.test(path)) {
      throw new Error(`AppAction path ${target.pathname} contains a path parameter, encoded separator, control character or trailing dot/space and is refused`);
    }
    if (DENIED_ROUTES.some((re) => re.test(path))) throw new Error(`AppAction route is blocked: ${target.pathname} has its own guarded tool or is a credential/payment/order route`);
    if (policy && !policy.pathPatterns.some((re) => re.test(path))) {
      throw new Error(`AppAction route ${target.pathname} is outside the ${policy.family} family this tool may call; pass the matching action from a prior response`);
    }
    return target.toString();
  }

  private resolveMethod(meta: AppActionMeta): AppActionMethod {
    const explicit = (meta.method ?? "").toUpperCase();
    const method = explicit || ((meta.rel ?? []).some((rel) => ["form", "create-form", "edit-form", "multipart"].includes(rel)) ? "POST" : "GET");
    if (!SAFE_METHODS.has(method as AppActionMethod)) throw new Error(`AppAction method is not allowed: ${method}`);
    return method as AppActionMethod;
  }

  private normalizedValues(values: AppActionValue[]): AppActionValue[] {
    return values.map((item) => {
      if (!item || typeof item.name !== "string" || !item.name) throw new Error("AppAction value name is required");
      if (isSensitiveFieldName(item.name)) throw new Error(`Sensitive AppAction field is blocked: ${item.name}`);
      return item;
    });
  }

  private addQuery(target: string, values: AppActionValue[]): string {
    const url = new URL(target);
    for (const item of values) {
      const pairs = this.queryPairs(item);
      if (url.searchParams.has(item.name)) url.searchParams.delete(item.name);
      for (const [key, value] of pairs) url.searchParams.append(key, value);
    }
    return url.toString();
  }

  private queryPairs(item: AppActionValue): Array<[string, string]> {
    const value = item.value;
    if (Array.isArray(value)) return value.map((v, index) => [value.length === 1 ? item.name : `${item.name}[${index}]`, this.scalar(v)]);
    return [[item.name, this.scalar(value)]];
  }

  private jsonBody(values: AppActionValue[]): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const item of values) body[item.name] = item.value;
    return body;
  }

  private multipartBody(values: AppActionValue[], files: AppActionFilePart[]): FormData {
    const body = new FormData();
    for (const item of values) {
      if (Array.isArray(item.value)) for (const value of item.value) body.append(item.name, this.scalar(value));
      else body.append(item.name, this.scalar(item.value));
    }
    for (const file of files) {
      if (!file.partName || !file.fileName || !file.dataUrl) throw new Error("File parts need partName, fileName, and dataUrl");
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(file.dataUrl);
      if (!match) throw new Error("File part dataUrl must be a base64 data URL");
      if (match[2] !== ";base64") throw new Error("File part dataUrl must be base64-encoded");
      if (file.mimeType && !ALLOWED_FILE_MIME_TYPES.has(file.mimeType)) throw new Error(`File MIME type not allowed: ${file.mimeType}`);
      const b64 = match[3];
      if (typeof b64 !== "string") throw new Error("File part dataUrl must contain base64 payload");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error(`File part size must be 1..${MAX_FILE_BYTES} bytes`);
      const blob = new Blob([new Uint8Array(bytes)], { type: file.mimeType || match[1] || "application/octet-stream" });
      body.append(file.partName, blob, file.fileName);
    }
    return body;
  }

  private scalar(value: unknown): string {
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value === null || value === undefined) return "";
    if (typeof value === "number" || typeof value === "string") return String(value);
    throw new Error("Unsupported AppAction value type");
  }

  private headers(multipart: boolean): Headers {
    const headers = new Headers({ accept: "application/json", "user-agent": this.options.userAgent ?? "ktor-client", "accept-language": this.options.acceptLanguage ?? "cs-CZ,cs;q=0.9,en;q=0.8", "Balancer-Guid": this.options.visitorId });
    if (!multipart) headers.set("content-type", "application/json");
    if (this.options.authorizationToken) headers.set("authorization", `Bearer ${this.options.authorizationToken}`);
    return headers;
  }

  private async requestWithCookies(target: string, init: RequestInit): Promise<FetchLikeResponse> {
    const headers = new Headers(init.headers);
    const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) headers.set("cookie", cookie);
    const response = await this.fetchImpl(target, { ...init, headers });
    const setCookies = (response.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const header of setCookies) {
      const first = header.split(";", 1)[0] ?? "";
      const separator = first.indexOf("=");
      if (separator > 0) this.cookies.set(first.slice(0, separator), first.slice(separator + 1));
    }
    return response;
  }
}
