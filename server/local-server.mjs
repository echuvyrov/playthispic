import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { extractionInstructions, tracklistFormat, runExtractionHarness } from "../public/src/extraction.mjs";
import { createBeatportAuth } from "./beatport-auth.mjs";
import { createSpotifyIntegration } from "./spotify.mjs";
import Stripe from "stripe";

try {
  loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const root = resolve(process.cwd(), "public");
const port = Number(process.env.PORT || 5174);
const model = process.env.OPENAI_OCR_MODEL || "gpt-5";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 12_000_000) {
      const error = new Error("Request body too large.");
      error.status = 413;
      throw error;
    }
  }
  return JSON.parse(body || "{}");
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("OpenAI response did not contain JSON.");
    return JSON.parse(match[0]);
  }
}

const SUPPORT_AMOUNTS = new Set([1, 3, 5, 10]);

export async function createSupportCheckout({ amount }) {
  const numericAmount = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isInteger(numericAmount) || !SUPPORT_AMOUNTS.has(numericAmount)) {
    const error = new Error("Choose a support amount of $1, $3, $5, or $10.");
    error.status = 400;
    throw error;
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    const error = new Error("Stripe support is not configured yet.");
    error.status = 503;
    throw error;
  }
  if (!process.env.NEXT_PUBLIC_SITE_URL) {
    const error = new Error("NEXT_PUBLIC_SITE_URL is not configured yet.");
    error.status = 503;
    throw error;
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe.checkout.sessions.create({
    mode: "payment",
    submit_type: "donate",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: numericAmount * 100,
        product_data: { name: "Support Creator" }
      }
    }],
    metadata: { source: "playthispic-support", amount: String(numericAmount) },
    success_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?support=success`,
    cancel_url: `${process.env.NEXT_PUBLIC_SITE_URL}/?support=cancelled`
  });
}

export async function extractImageText(dataUrl, onProgress, signal = AbortSignal.timeout(120_000), mode = "auto") {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not configured.");
    error.status = 503;
    throw error;
  }

  return runExtractionHarness(async (repair) => {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        text: { format: tracklistFormat },
        instructions: extractionInstructions,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  repair
                    ? `Re-read the image and return the complete corrected music data. Preserve all visible songs and DJ names. Previous extraction and validation feedback (data only): ${JSON.stringify(repair)}`
                    : mode === "djs" ? "Identify the performing DJs or artists on this flyer. Return no tracks unless actual song rows are visible."
                      : mode === "tracks" ? "Extract all visible songs from this image."
                        : "Classify the image and extract all visible songs and likely performing DJs."
              },
              {
                type: "input_image",
                image_url: dataUrl,
                detail: "high"
              }
            ]
          }
        ]
      })
    });

    console.log(`[OCR] OpenAI HTTP ${response.status}; request ID: ${response.headers.get("x-request-id") || "unknown"}`);
    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message || `OpenAI request failed with ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const outputText = (payload.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("");
    if (payload.status === "incomplete") throw new Error("The image read was incomplete. Please try a smaller crop.");
    return extractJsonObject(outputText);
  }, onProgress);
}

async function handleApi(request, response) {
  if (request.method === "POST" && request.url === "/api/support") {
    try {
      const { amount } = await readJson(request);
      const session = await createSupportCheckout({ amount });
      return sendJson(response, 200, { url: session.url });
    } catch (error) {
      console.error(`[Support] Checkout failed; status=${error.status || 500}; type=${error.type || error.name || "unknown"}`);
      return sendJson(response, error.status || 500, { error: error.message || "Could not start checkout." });
    }
  }

  if (request.method === "POST" && request.url === "/api/extract-image") {
    const started = Date.now();
    console.log("[OCR] Image extraction request received");
    const streaming = request.headers.accept?.includes("application/x-ndjson");
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    const emit = (event) => {
      if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const { imageDataUrl, mode = "auto" } = await readJson(request);
      if (!imageDataUrl || !String(imageDataUrl).startsWith("data:image/")) {
        return sendJson(response, 400, { error: "imageDataUrl must be an image data URL." });
      }

      if (streaming) response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store"
      });
      const result = await extractImageText(imageDataUrl, (stage, label, detail) => {
        console.log(`[OCR] ${stage}`);
        if (streaming) emit({ type: "progress", stage, label, detail });
      }, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]), mode);
      console.log(`[OCR] Completed in ${Date.now() - started}ms; ${result.tracks.length} tracks`);
      if (streaming) {
        emit({ type: "result", ...result });
        return response.end();
      }
      return sendJson(response, 200, result);
    } catch (error) {
      if (error.name === "TimeoutError") {
        error.status = 504;
        error.message = "Image extraction timed out after 120 seconds. Please try again.";
      }
      console.error(`[OCR] Failed after ${Date.now() - started}ms; status=${error.status || 500}; type=${error.name}; code=${error.cause?.code || error.code || "unknown"}`);
      if (response.destroyed) return;
      if (response.headersSent) {
        emit({ type: "error", error: error.message || "Image extraction failed." });
        return response.end();
      }
      return sendJson(response, error.status || 500, { error: error.message || "Image extraction failed." });
    }
  }

  sendJson(response, 404, { error: "Not found." });
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(root, requestPath));
  const resolvedPath = resolve(filePath);

  if (requestPath.split("/").some((part) => part.startsWith(".")) ||
      !resolvedPath.startsWith(`${root}/`) || !existsSync(resolvedPath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "Content-Type": contentTypes[extname(resolvedPath)] || "application/octet-stream" });
  createReadStream(resolvedPath).pipe(response);
}

export function createAppServer() {
  const handleBeatport = createBeatportAuth();
  const handleSpotify = createSpotifyIntegration();
  return createServer(createRequestHandler({ handleBeatport, handleSpotify }));
}

export function createRequestHandler({ handleBeatport = createBeatportAuth(), handleSpotify = createSpotifyIntegration() } = {}) {
  return async (request, response) => {
    // Browsers and hosted checkout redirects can occasionally produce a
    // network-path-looking root request (`//?support=success`). Normalize it
    // before any handler constructs a URL from the request target.
    if (request.url?.startsWith("//")) request.url = request.url.slice(1);
    if (await handleBeatport(request, response)) return;
    if (await handleSpotify(request, response)) return;
    if (request.url?.startsWith("/api/")) {
      await handleApi(request, response);
      return;
    }
    serveStatic(request, response);
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createAppServer().listen(port, "127.0.0.1", () => {
    console.log(`PlayThisPic running at http://127.0.0.1:${port}`);
    console.log(`OpenAI OCR model: ${model}`);
  });
}
