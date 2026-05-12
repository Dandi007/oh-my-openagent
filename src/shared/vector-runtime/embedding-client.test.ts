import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createHttpEmbeddingClient } from "./embedding-client"
import type { ResolvedVectorRuntimeEnv } from "./types"

// ── Helpers ───────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<ResolvedVectorRuntimeEnv["embedding"]> & { timeoutMs?: number } = {}): ResolvedVectorRuntimeEnv {
  return {
    backend: "lancedb",
    embedding: {
      endpoint: "http://localhost:8080/v1/embeddings",
      model: "test-model",
      dimensions: overrides.dimensions ?? undefined,
      ...overrides,
    },
    timeoutMs: overrides.timeoutMs ?? 5000,
  }
}

function makeEmbeddingResponse(embeddings: number[][]): object {
  return {
    data: embeddings.map((embedding) => ({ embedding })),
  }
}

function makeTextResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// ── Setup / teardown ──────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch
let originalEnv: typeof process.env

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalEnv = { ...process.env }
  delete process.env.AGENT_EMBEDDING_API_KEY
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env = originalEnv
})

// ── Success path ──────────────────────────────────────────────────────

describe("createHttpEmbeddingClient — success", () => {
  test("returns embeddings for valid input", async () => {
    // #given a client with a mock fetch that returns valid embeddings
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1, 0.2], [0.3, 0.4]]))),
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding two texts
    const result = await client.embed(["hello", "world"])

    // #then the result is two vectors of length 2
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual([0.1, 0.2])
    expect(result[1]).toEqual([0.3, 0.4])
  })

  test("sends correct OpenAI-compatible request body", async () => {
    // #given a client with a mock fetch
    const env = makeEnv()
    let capturedBody: string | null = null
    const mockFetch = mock((_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string ?? null
      return Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1]])))
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding a single text
    await client.embed(["test text"])

    // #then the request body contains model and input
    const parsed = JSON.parse(capturedBody!)
    expect(parsed.model).toBe("test-model")
    expect(parsed.input).toEqual(["test text"])
  })

  test("sends POST to the configured endpoint", async () => {
    // #given a client with a specific endpoint
    const env = makeEnv({ endpoint: "http://custom:9999/embed" })
    let capturedUrl: string | null = null
    const mockFetch = mock((url: string) => {
      capturedUrl = url
      return Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1]])))
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    await client.embed(["text"])

    // #then the URL matches the configured endpoint
    expect(capturedUrl!).toBe("http://custom:9999/embed")
  })
})

// ── Auth header ───────────────────────────────────────────────────────

describe("createHttpEmbeddingClient — auth header", () => {
  test("includes Authorization header when API key is set", async () => {
    // #given an API key in process.env
    process.env.AGENT_EMBEDDING_API_KEY = "sk-test-key-123"
    const env = makeEnv()
    let capturedHeaders: Record<string, string> | undefined
    const mockFetch = mock((_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined
      return Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1]])))
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    await client.embed(["text"])

    // #then the Authorization header is present
    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!["Authorization"]).toBe("Bearer sk-test-key-123")
  })

  test("omits Authorization header when API key is not set", async () => {
    // #given no API key
    delete process.env.AGENT_EMBEDDING_API_KEY
    const env = makeEnv()
    let capturedHeaders: Record<string, string> | undefined
    const mockFetch = mock((_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined
      return Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1]])))
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    await client.embed(["text"])

    // #then no Authorization header is present
    expect(capturedHeaders).toBeDefined()
    expect(capturedHeaders!["Authorization"]).toBeUndefined()
  })
})

// ── Dimension validation ──────────────────────────────────────────────

describe("createHttpEmbeddingClient — dimension validation", () => {
  test("accepts response when dimensions match configured value", async () => {
    // #given dimensions configured to 2
    const env = makeEnv({ dimensions: 2 })
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1, 0.2]]))),
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    const result = await client.embed(["text"])

    // #then it succeeds
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual([0.1, 0.2])
  })

  test("throws when response dimensions do not match configured value", async () => {
    // #given dimensions configured to 3 but response returns 2
    const env = makeEnv({ dimensions: 3 })
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1, 0.2]]))),
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws a dimension mismatch error
    await expect(client.embed(["text"])).rejects.toThrow(/dimension/i)
  })

  test("does not validate dimensions when not configured", async () => {
    // #given no dimensions configured
    const env = makeEnv({ dimensions: undefined })
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1]]))),
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    const result = await client.embed(["text"])

    // #then it succeeds without dimension validation
    expect(result).toHaveLength(1)
  })
})

// ── Malformed response ────────────────────────────────────────────────

describe("createHttpEmbeddingClient — malformed response", () => {
  test("throws when response has no data field", async () => {
    // #given a response missing the data field
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({}))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws
    await expect(client.embed(["text"])).rejects.toThrow()
  })

  test("throws when data is not an array", async () => {
    // #given a response where data is not an array
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ data: "not-an-array" }))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws
    await expect(client.embed(["text"])).rejects.toThrow()
  })

  test("throws when an embedding entry is missing", async () => {
    // #given a response where an entry has no embedding field
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ data: [{}] }))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws
    await expect(client.embed(["text"])).rejects.toThrow()
  })

  test("throws when embedding is not an array of numbers", async () => {
    // #given a response where embedding is a string
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ data: [{ embedding: "not-an-array" }] }))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws
    await expect(client.embed(["text"])).rejects.toThrow()
  })

  test("throws when embedding contains non-number elements", async () => {
    // #given a response where embedding contains a string
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ data: [{ embedding: [0.1, "bad", 0.3] }] }))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws
    await expect(client.embed(["text"])).rejects.toThrow()
  })

  test("throws when response is not valid JSON", async () => {
    // #given a response with invalid JSON
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } }))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws
    await expect(client.embed(["text"])).rejects.toThrow()
  })
})

// ── Non-2xx response ──────────────────────────────────────────────────

describe("createHttpEmbeddingClient — non-2xx response", () => {
  test("throws with status code on 400", async () => {
    // #given a 400 response
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ error: "bad request" }, 400))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws with status code
    await expect(client.embed(["text"])).rejects.toThrow(/400/)
  })

  test("throws with status code on 500", async () => {
    // #given a 500 response
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ error: "internal error" }, 500))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws with status code
    await expect(client.embed(["text"])).rejects.toThrow(/500/)
  })

  test("throws with status code on 401", async () => {
    // #given a 401 response
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ error: "unauthorized" }, 401))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws with status code
    await expect(client.embed(["text"])).rejects.toThrow(/401/)
  })
})

// ── Timeout / abort ───────────────────────────────────────────────────

describe("createHttpEmbeddingClient — timeout", () => {
  test("uses AbortController with configured timeout", async () => {
    // #given a client with a 100ms timeout
    const env = makeEnv({ timeoutMs: 100 })
    // Mock fetch that respects the AbortSignal
    const mockFetch = mock((_url: string, init?: RequestInit) => {
      // Verify signal is present
      expect(init?.signal).toBeDefined()
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      // Return a promise that rejects with AbortError when the signal fires
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          const onAbort = () => {
            const err = new DOMException("The operation was aborted", "AbortError")
            reject(err)
          }
          if (signal.aborted) {
            onAbort()
          } else {
            signal.addEventListener("abort", onAbort, { once: true })
          }
        }
      })
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    // #then it throws an abort/timeout error
    await expect(client.embed(["text"])).rejects.toThrow()
  })

  test("uses default timeout when not configured", async () => {
    // #given a client with no timeout configured
    const env = makeEnv({ timeoutMs: undefined })
    let capturedSignal: AbortSignal | null | undefined
    const mockFetch = mock((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1]])))
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding
    await client.embed(["text"])

    // #then a signal is still passed (with default timeout)
    expect(capturedSignal).toBeDefined()
  })
})

// ── API key redaction ─────────────────────────────────────────────────

describe("createHttpEmbeddingClient — API key redaction", () => {
  test("API key never appears in error messages on non-2xx", async () => {
    // #given an API key is set
    process.env.AGENT_EMBEDDING_API_KEY = "sk-secret-do-not-leak"
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ error: "unauthorized" }, 401))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding fails
    let errorMessage = ""
    try {
      await client.embed(["text"])
    } catch (e) {
      errorMessage = String(e)
    }

    // #then the API key is not in the error message
    expect(errorMessage).not.toContain("sk-secret-do-not-leak")
    expect(errorMessage).not.toContain("sk-secret")
  })

  test("API key never appears in error messages on malformed response", async () => {
    // #given an API key is set
    process.env.AGENT_EMBEDDING_API_KEY = "sk-another-secret"
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({}))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding fails
    let errorMessage = ""
    try {
      await client.embed(["text"])
    } catch (e) {
      errorMessage = String(e)
    }

    // #then the API key is not in the error message
    expect(errorMessage).not.toContain("sk-another-secret")
  })

  test("API key never appears in error messages on dimension mismatch", async () => {
    // #given an API key is set and dimensions are configured
    process.env.AGENT_EMBEDDING_API_KEY = "sk-dim-secret"
    const env = makeEnv({ dimensions: 3 })
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse(makeEmbeddingResponse([[0.1, 0.2]])))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding fails
    let errorMessage = ""
    try {
      await client.embed(["text"])
    } catch (e) {
      errorMessage = String(e)
    }

    // #then the API key is not in the error message
    expect(errorMessage).not.toContain("sk-dim-secret")
  })

  test("API key never appears in error messages on timeout", async () => {
    // #given an API key is set with a short timeout
    process.env.AGENT_EMBEDDING_API_KEY = "sk-timeout-secret"
    const env = makeEnv({ timeoutMs: 1 })
    const mockFetch = mock((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          const onAbort = () => {
            const err = new DOMException("The operation was aborted", "AbortError")
            reject(err)
          }
          if (signal.aborted) {
            onAbort()
          } else {
            signal.addEventListener("abort", onAbort, { once: true })
          }
        }
      })
    })
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding times out
    let errorMessage = ""
    try {
      await client.embed(["text"])
    } catch (e) {
      errorMessage = String(e)
    }

    // #then the API key is not in the error message
    expect(errorMessage).not.toContain("sk-timeout-secret")
  })

  test("serialized error diagnostics never contain API key", async () => {
    // #given an API key is set
    process.env.AGENT_EMBEDDING_API_KEY = "sk-serial-secret"
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse({ error: "server error" }, 500))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding fails
    let serialized = ""
    try {
      await client.embed(["text"])
    } catch (e) {
      serialized = JSON.stringify(e)
    }

    // #then the API key is not in the serialized error
    expect(serialized).not.toContain("sk-serial-secret")
  })
})

// ── Empty input ───────────────────────────────────────────────────────

describe("createHttpEmbeddingClient — empty input", () => {
  test("returns empty array for empty input", async () => {
    // #given a client
    const env = makeEnv()
    const mockFetch = mock(() =>
      Promise.resolve(makeTextResponse(makeEmbeddingResponse([])))
    )
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch

    const client = createHttpEmbeddingClient(env)

    // #when embedding an empty array
    const result = await client.embed([])

    // #then the result is an empty array
    expect(result).toEqual([])
  })
})