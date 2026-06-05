# @flixly/sdk

Official JavaScript / TypeScript SDK for the [Flixly](https://www.flixly.ai) AI API. Generate images, video, audio, and chat completions from one client.

## Install

```bash
npm install @flixly/sdk
```

Requires Node.js 18+ (uses global `fetch`).

## Quick start

```ts
import { Flixly } from "@flixly/sdk";

const flixly = new Flixly({ apiKey: process.env.FLIXLY_API_KEY! });

// Fast: image models return synchronously.
const result = await flixly.generateAndWait({
  model: "flux-dev",
  prompt: "A cat wearing a top hat, oil painting style",
  type: "TEXT_TO_IMAGE",
  input: { aspect_ratio: "1:1", resolution: "1K" },
});

console.log(result.data.output_url); // cdn.flixly.ai URL
```

Get an API key at [www.flixly.ai/dashboard/settings/api-keys](https://www.flixly.ai/dashboard/settings/api-keys).

## Webhooks (recommended for video / slow models)

```ts
await flixly.generate({
  model: "veo-3-fast",
  prompt: "Cinematic shot of mountains at dawn",
  type: "TEXT_TO_VIDEO",
  webhook_url: "https://example.com/flixly-webhook",
});
```

Verify incoming webhook requests:

```ts
// In your webhook handler — Express, Hono, Next.js, etc.
import { Flixly } from "@flixly/sdk";

const valid = await Flixly.verifyWebhookSignature({
  secret: process.env.FLIXLY_WEBHOOK_SECRET!,
  timestamp: req.headers["x-flixly-timestamp"]!,
  signature: req.headers["x-flixly-signature"]!,
  body: rawBody, // pass the unmodified request body — JSON.parse + restringify will break verification
});
if (!valid) return res.status(401).end();
```

The webhook secret is shown once when you create the API key. Store it on your server like any other secret.

## Rate limits

Every response includes parsed rate-limit info — use it to pace yourself before a 429:

```ts
const res = await flixly.listModels();
console.log(res.rateLimit);
// { limit: 60, remaining: 42, resetAtSec: 1735056000 }
```

## Chat (OpenAI-compatible)

```ts
// Non-streaming
const res = await flixly.chat({
  model: "gpt-5-4-mini",
  messages: [
    { role: "user", content: "Explain async/await in one sentence." },
  ],
});
console.log(res.data.choices[0].message.content);

// Streaming
for await (const chunk of flixly.chatStream({
  model: "gpt-5-4-mini",
  messages: [{ role: "user", content: "Write a haiku about TypeScript" }],
})) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
}
```

## Errors

API errors throw `FlixlyError` with the response code, status, and details:

```ts
import { Flixly, FlixlyError } from "@flixly/sdk";

try {
  await flixly.generate({ model: "flux-dev", prompt: "" });
} catch (err) {
  if (err instanceof FlixlyError) {
    console.log(err.code, err.status, err.message);
    // "invalid_request" 400 "prompt is required"
  }
}
```

## Configuration

```ts
new Flixly({
  apiKey: "flx_live_...",
  baseUrl: "https://www.flixly.ai", // default
  timeoutMs: 120_000,               // default 2 minutes
  fetch: customFetch,               // override (e.g. for proxies)
});
```

## Spending caps & API key management

Set a per-key monthly credit limit, configure default webhook URLs, and rotate webhook secrets at [/dashboard/settings/api-keys](https://www.flixly.ai/dashboard/settings/api-keys).

## License

MIT
