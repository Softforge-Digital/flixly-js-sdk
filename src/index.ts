/**
 * @flixly/sdk — Official SDK for the Flixly AI API.
 *
 * @example
 * ```ts
 * import { Flixly } from "@flixly/sdk";
 *
 * const flixly = new Flixly({ apiKey: process.env.FLIXLY_API_KEY! });
 *
 * // Quick: kick off a generation and wait for it.
 * const result = await flixly.generateAndWait({
 *   model: "flux-dev",
 *   prompt: "A cat wearing a top hat, oil painting style",
 *   type: "TEXT_TO_IMAGE",
 *   input: { aspect_ratio: "1:1", resolution: "1K" },
 * });
 * console.log(result.output_url);
 *
 * // Or: subscribe via webhook (preferred for video / slow models).
 * await flixly.generate({
 *   model: "veo-3-fast",
 *   prompt: "Cinematic shot of mountains at dawn",
 *   webhook_url: "https://example.com/flixly-webhook",
 * });
 *
 * // Verify incoming webhooks:
 * const valid = await Flixly.verifyWebhookSignature({
 *   secret: process.env.FLIXLY_WEBHOOK_SECRET!,
 *   timestamp: req.headers["x-flixly-timestamp"]!,
 *   signature: req.headers["x-flixly-signature"]!,
 *   body: req.rawBody,
 * });
 * if (!valid) throw new Error("invalid signature");
 * ```
 */

export const BASE_URL = "https://www.flixly.ai";

// ============================================
// TYPES
// ============================================

export type TaskType =
  | "TEXT_TO_IMAGE"
  | "IMAGE_TO_IMAGE"
  | "TEXT_TO_VIDEO"
  | "IMAGE_TO_VIDEO"
  | "VIDEO_TO_VIDEO"
  | "TEXT_TO_SPEECH"
  | "VOICE_CLONE"
  | "MUSIC_GENERATION"
  | "UPSCALE"
  | "REMOVE_BACKGROUND";

export type GenerationStatus = "pending" | "processing" | "completed" | "failed";

export interface GenerateInput {
  aspect_ratio?: string;
  resolution?: string;
  duration?: string | number;
  image_url?: string;
  video_url?: string;
  audio_url?: string;
  [key: string]: unknown;
}

export interface GenerateRequest {
  /** Model id from `listModels()`. */
  model: string;
  /** Text prompt. */
  prompt: string;
  /** Task type. Inferred from the model when omitted. */
  type?: TaskType;
  /** Model-specific parameters (aspect ratio, resolution, image_url, etc.). */
  input?: GenerateInput;
  /**
   * If set, we POST a signed event to this URL when the generation
   * finishes. Overrides the key's default. Verify with
   * `Flixly.verifyWebhookSignature()`.
   */
  webhook_url?: string;
}

export interface Generation {
  id: string;
  status: GenerationStatus;
  type: string;
  model: string | null;
  output_url: string | null;
  status_url: string;
  webhook_url?: string | null;
  credits_charged: number;
  error?: string | null;
  created_at: string;
  completed_at: string | null;
  message?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  credits_charged: number;
}

export interface FlixlyModel {
  id: string;
  name: string;
  type: string;
  capabilities: string[];
  estimated_credits?: number | null;
  estimated_credits_per_1k_tokens?: number | null;
}

export interface Account {
  credits: { subscription: number; bonus: number; total: number };
  plan: { name: string; parallel_limit: number; rate_limit: number; renews_at: string | null };
  usage: { total_requests: number; total_credits_used: number; completed: number; failed: number; pending: number };
}

export interface RateLimit {
  /** Requests allowed per minute on this key's plan. */
  limit: number;
  /** Requests left in the current 60s window at the time of the response. */
  remaining: number;
  /** Unix epoch seconds when the window resets. */
  resetAtSec: number;
}

/** A successful API response, with rate-limit headers parsed out. */
export interface FlixlyResponse<T> {
  data: T;
  rateLimit: RateLimit | null;
}

// ============================================
// ERRORS
// ============================================

export class FlixlyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly rateLimit: RateLimit | null;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    rateLimit: RateLimit | null;
  }) {
    super(args.message);
    this.name = "FlixlyError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
    this.rateLimit = args.rateLimit;
  }
}

// ============================================
// CLIENT
// ============================================

export interface FlixlyOptions {
  apiKey: string;
  /** Override the API base URL (defaults to https://www.flixly.ai). */
  baseUrl?: string;
  /** Custom fetch implementation. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 120_000 (2 minutes). */
  timeoutMs?: number;
}

export class Flixly {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FlixlyOptions) {
    if (!opts?.apiKey) throw new Error("Flixly: `apiKey` is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || BASE_URL).replace(/\/$/, "");
    // Bind fetch to globalThis so calling it as `this.fetchImpl(...)`
    // doesn't pass the Flixly instance as the receiver. Native fetch
    // requires `this === window` (or globalThis); without the bind,
    // it throws "Failed to execute 'fetch' on 'Window': Illegal
    // invocation" in any environment that's strict about the
    // receiver check (Chrome, Figma's UI iframe, Edge, etc.).
    const baseFetch = opts.fetch || globalThis.fetch;
    if (!baseFetch) {
      throw new Error("Flixly: no fetch implementation. Pass `fetch` in options on Node < 18.");
    }
    this.fetchImpl = opts.fetch ? baseFetch : baseFetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  // ─── Generations ───────────────────────────────────────────────

  /** Submit a generation. Returns immediately with `processing` for async models, or `completed` for fast sync models. */
  async generate(req: GenerateRequest): Promise<FlixlyResponse<Generation>> {
    return this.request<Generation>("POST", "/api/v1/generate", req);
  }

  /** Fetch the current state of a generation. */
  async getGeneration(id: string): Promise<FlixlyResponse<Generation>> {
    return this.request<Generation>("GET", `/api/v1/generations/${encodeURIComponent(id)}`);
  }

  /**
   * Submit a generation and poll until it completes or fails.
   * Useful for short pipelines / one-shot scripts. Prefer
   * `generate({ webhook_url })` in production.
   */
  async generateAndWait(
    req: GenerateRequest,
    opts: { pollIntervalMs?: number; maxWaitMs?: number } = {},
  ): Promise<FlixlyResponse<Generation>> {
    const start = Date.now();
    const interval = opts.pollIntervalMs ?? 2_000;
    const maxWait = opts.maxWaitMs ?? 10 * 60_000;

    const initial = await this.generate(req);
    if (initial.data.status === "completed" || initial.data.status === "failed") {
      return initial;
    }

    let last = initial;
    while (Date.now() - start < maxWait) {
      await sleep(interval);
      last = await this.getGeneration(initial.data.id);
      if (last.data.status === "completed" || last.data.status === "failed") {
        return last;
      }
    }
    throw new FlixlyError({
      status: 408,
      code: "timeout",
      message: `Generation ${initial.data.id} did not finish within ${Math.round(maxWait / 1000)}s. Last status: ${last.data.status}.`,
      rateLimit: last.rateLimit,
    });
  }

  // ─── Models ────────────────────────────────────────────────────

  /** List all available models. Includes per-model estimated_credits when authenticated. */
  async listModels(): Promise<FlixlyResponse<{ models: FlixlyModel[]; total: number }>> {
    return this.request<{ models: FlixlyModel[]; total: number }>("GET", "/api/v1/models");
  }

  // ─── Chat ──────────────────────────────────────────────────────

  /** OpenAI-compatible chat completion (non-streaming). */
  async chat(req: Omit<ChatRequest, "stream"> & { stream?: false }): Promise<FlixlyResponse<ChatResponse>> {
    return this.request<ChatResponse>("POST", "/api/v1/chat/completions", { ...req, stream: false });
  }

  /**
   * OpenAI-compatible streaming chat completion. Returns an async
   * iterable of `chat.completion.chunk` events as parsed JSON. The
   * stream terminates on `[DONE]`.
   */
  async *chatStream(req: Omit<ChatRequest, "stream">): AsyncIterable<any> {
    const url = `${this.baseUrl}/api/v1/chat/completions`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ...req, stream: true }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw await responseToError(res);
    }
    if (!res.body) throw new Error("Flixly: streaming response has no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload);
        } catch {
          // Malformed SSE chunk — skip rather than abort the stream.
        }
      }
    }
  }

  // ─── Account ───────────────────────────────────────────────────

  /** Credit balance, plan, parallel + rate limits, and aggregate usage. */
  async getAccount(): Promise<FlixlyResponse<Account>> {
    return this.request<Account>("GET", "/api/v1/account");
  }

  // ─── Webhook signature verification (static) ───────────────────

  /**
   * Verify a Flixly webhook delivery. Returns true if and only if the
   * signature is valid AND the timestamp is within `tolerance` seconds.
   *
   * Call this on EVERY webhook POST you receive — without it, anyone
   * who guesses the URL can forge a delivery.
   */
  static async verifyWebhookSignature(args: VerifyWebhookArgs): Promise<boolean> {
    if (!args.signature?.startsWith("sha256=")) return false;
    const provided = args.signature.slice(7).toLowerCase();
    const ts = Number(args.timestamp);
    if (!Number.isFinite(ts)) return false;
    const now = Math.floor(Date.now() / 1000);
    const tolerance = args.tolerance ?? 300;
    if (Math.abs(now - ts) > tolerance) return false;

    const bodyStr = typeof args.body === "string" ? args.body : new TextDecoder().decode(args.body);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(args.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${args.timestamp}.${bodyStr}`));
    const expectedHex = bufferToHex(sigBuf);

    return timingSafeEqual(expectedHex, provided);
  }

  // ─── Internals ─────────────────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": "flixly-js/0.1.0",
      ...extra,
    };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<FlixlyResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(body ? { "Content-Type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const rateLimit = parseRateLimit(res.headers);
    if (!res.ok) {
      throw await responseToError(res, rateLimit);
    }
    const data = (await res.json()) as T;
    return { data, rateLimit };
  }
}

// ============================================
// WEBHOOK VERIFICATION
// ============================================

export interface VerifyWebhookArgs {
  /** The HMAC secret you stored from your API key's webhook settings. */
  secret: string;
  /** The `X-Flixly-Timestamp` request header value (unix seconds, string). */
  timestamp: string;
  /** The `X-Flixly-Signature` request header value (`sha256=<hex>`). */
  signature: string;
  /** Raw request body bytes or string. MUST be unmodified — JSON.parse + re-stringify will break verification. */
  body: string | Uint8Array;
  /** Reject signatures older than this many seconds. Defaults to 300 (5 minutes) to prevent replays. */
  tolerance?: number;
}

// ============================================
// HELPERS
// ============================================

function parseRateLimit(h: Headers): RateLimit | null {
  const limit = Number(h.get("X-RateLimit-Limit"));
  const remaining = Number(h.get("X-RateLimit-Remaining"));
  const resetAtSec = Number(h.get("X-RateLimit-Reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || !Number.isFinite(resetAtSec)) {
    return null;
  }
  return { limit, remaining, resetAtSec };
}

async function responseToError(res: Response, rateLimit?: RateLimit | null): Promise<FlixlyError> {
  const rl = rateLimit ?? parseRateLimit(res.headers);
  let code = "internal_error";
  let message = `HTTP ${res.status}`;
  let details: Record<string, unknown> | undefined;
  try {
    const body = await res.json();
    if (body?.error) {
      code = body.error.code || code;
      message = body.error.message || message;
      details = body.error.details;
    }
  } catch {
    // Body wasn't JSON — keep the generic message.
  }
  return new FlixlyError({ status: res.status, code, message, details, rateLimit: rl });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** Length-bounded constant-time string compare to avoid timing attacks on the signature. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
