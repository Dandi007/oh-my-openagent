/**
 * HTTP Embedding Client
 *
 * Creates an embedding client that POSTs to an OpenAI-compatible
 * embedding endpoint.  The client reads AGENT_EMBEDDING_API_KEY from
 * process.env directly (it is intentionally excluded from
 * ResolvedVectorRuntimeEnv to prevent accidental serialization).
 *
 * Errors are stable and machine-diagnosable — they never include the
 * API key, request bodies, or user text.
 */

import type { ResolvedVectorRuntimeEnv } from "./types"

// ── Public types ──────────────────────────────────────────────────────

/** Embedding client returned by createHttpEmbeddingClient. */
export interface EmbeddingClient {
  /**
   * Compute embeddings for an array of texts.
   * Returns one vector per input text in the same order.
   */
  embed(texts: string[]): Promise<number[][]>
}

// ── Error types ───────────────────────────────────────────────────────

/** Base class for embedding client errors — never includes secrets. */
export class EmbeddingClientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmbeddingClientError"
  }
}

export class EmbeddingHttpError extends EmbeddingClientError {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "EmbeddingHttpError"
    this.status = status
  }
}

export class EmbeddingDimensionError extends EmbeddingClientError {
  readonly expected: number
  readonly received: number

  constructor(expected: number, received: number) {
    super(
      `embedding dimension mismatch: expected ${expected}, received ${received}`,
    )
    this.name = "EmbeddingDimensionError"
    this.expected = expected
    this.received = received
  }
}

export class EmbeddingParseError extends EmbeddingClientError {
  constructor(reason: string) {
    super(`embedding response parse error: ${reason}`)
    this.name = "EmbeddingParseError"
  }
}

export class EmbeddingTimeoutError extends EmbeddingClientError {
  constructor(timeoutMs: number) {
    super(`embedding request timed out after ${timeoutMs}ms`)
    this.name = "EmbeddingTimeoutError"
  }
}

// ── Constants ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Read the embedding API key from process.env.
 * Returns undefined when the key is not set or empty.
 */
function readApiKey(): string | undefined {
  if (typeof process === "undefined") return undefined
  const raw = process.env["AGENT_EMBEDDING_API_KEY"]
  if (raw === undefined || raw.trim() === "") return undefined
  return raw.trim()
}

/**
 * Validate that a value is an array of finite numbers.
 * Returns the array if valid, throws EmbeddingParseError otherwise.
 */
function assertNumberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) {
    throw new EmbeddingParseError(`${label} is not an array`)
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "number" || !Number.isFinite(value[i])) {
      throw new EmbeddingParseError(
        `${label}[${i}] is not a finite number`,
      )
    }
  }
  return value as number[]
}

/**
 * Parse the OpenAI-compatible embedding response body.
 * Validates structure and returns the list of embedding vectors.
 */
function parseEmbeddingResponse(
  body: unknown,
  expectedDimensions?: number,
): number[][] {
  if (body === null || typeof body !== "object") {
    throw new EmbeddingParseError("response body is not an object")
  }

  const obj = body as Record<string, unknown>

  if (!Array.isArray(obj.data)) {
    throw new EmbeddingParseError("response.data is not an array")
  }

  const embeddings: number[][] = []

  for (let i = 0; i < obj.data.length; i++) {
    const item = obj.data[i]
    if (item === null || typeof item !== "object") {
      throw new EmbeddingParseError(`response.data[${i}] is not an object`)
    }

    const itemObj = item as Record<string, unknown>
    const embedding = assertNumberArray(
      itemObj.embedding,
      `response.data[${i}].embedding`,
    )

    if (expectedDimensions !== undefined && embedding.length !== expectedDimensions) {
      throw new EmbeddingDimensionError(expectedDimensions, embedding.length)
    }

    embeddings.push(embedding)
  }

  return embeddings
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create an HTTP embedding client from the resolved vector runtime env.
 *
 * The client POSTs to `env.embedding.endpoint` with an OpenAI-compatible
 * JSON body containing `model` and `input`.  If `AGENT_EMBEDDING_API_KEY`
 * is set in process.env, the request includes an `Authorization: Bearer`
 * header — but the key is never included in error messages, diagnostics,
 * or serialized output.
 *
 * When `env.embedding.dimensions` is configured, the client validates
 * that every returned embedding vector has exactly that many dimensions.
 *
 * The client uses `AbortController` with `env.timeoutMs` (default 30s)
 * to enforce a timeout budget.
 */
export function createHttpEmbeddingClient(
  env: ResolvedVectorRuntimeEnv,
): EmbeddingClient {
  const endpoint = env.embedding.endpoint
  const model = env.embedding.model
  const dimensions = env.embedding.dimensions
  const timeoutMs = env.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const apiKey = readApiKey()

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    if (!endpoint) {
      throw new EmbeddingClientError(
        "embedding endpoint is not configured",
      )
    }

    if (!model) {
      throw new EmbeddingClientError(
        "embedding model is not configured",
      )
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (apiKey !== undefined) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      })
    } catch (cause) {
      clearTimeout(timeoutId)
      if (cause instanceof DOMException && cause.name === "AbortError") {
        throw new EmbeddingTimeoutError(timeoutMs)
      }
      throw new EmbeddingClientError(
        `embedding request failed: ${String(cause)}`,
      )
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new EmbeddingHttpError(
        response.status,
        `embedding endpoint returned HTTP ${response.status}`,
      )
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new EmbeddingParseError("response body is not valid JSON")
    }

    return parseEmbeddingResponse(body, dimensions)
  }

  return { embed }
}