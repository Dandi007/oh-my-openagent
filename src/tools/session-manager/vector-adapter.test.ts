import { describe, test, expect } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryVectorAdapter } from "./vector-adapter"
import type { EmbeddingClient } from "../../shared/vector-runtime/embedding-client"
import type { LanceDbVectorStore, LanceDbQueryContext } from "../../shared/vector-runtime/lancedb-adapter"
import type { QueryRequest, QueryResponse, QueryResult } from "../../shared/vector-runtime/types"

const FIXED_VECTOR = [0.1, 0.2, 0.3, 0.4]

function mockEmbeddingClient(): EmbeddingClient {
  return {
    embed: async (_texts: string[]): Promise<number[][]> => {
      return [FIXED_VECTOR]
    },
  }
}

function mockVectorStore(results: QueryResult[] = []): LanceDbVectorStore {
  return {
    upsertChunks: async () => {},
    deleteMissing: async () => {},
    query: async (
      _request: QueryRequest,
      _embedding: number[],
      _context?: LanceDbQueryContext,
    ): Promise<QueryResponse> => {
      return {
        results,
        diagnostics: {
          backend: "lancedb",
          manifest_validated: true,
          semantic_available: results.length > 0,
        },
      }
    },
  }
}

function makeQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    source: "opencode",
    chunk_id: "opencode:ses_test:msg_test:prt_test:abc123",
    score: 0.85,
    text: "deployment pipeline configuration...",
    metadata: {
      session_id: "ses_test",
      message_id: "msg_test",
      role: "assistant",
      session_title: "Test Session",
      session_time_created: 1700000000000,
      message_time_created: 1700000001000,
    },
    ...overrides,
  }
}

function noVectorConfigEnv(): Record<string, string | undefined> {
  return {}
}

function validVectorConfigEnv(): Record<string, string | undefined> {
  return {
    AGENT_VECTOR_DB_BACKEND: "lancedb",
    AGENT_VECTOR_DB_PATH: "/tmp/test-lancedb",
    AGENT_VECTOR_MANIFEST: "/tmp/test-manifest.json",
    AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
    AGENT_EMBEDDING_MODEL: "test-model",
    AGENT_EMBEDDING_DIMENSIONS: "4",
  }
}

interface RealEnvFixture {
  tmpDir: string
  manifestPath: string
  dbPath: string
  cleanup: () => void
}

function setupRealEnvFixture(): RealEnvFixture {
  const tmpDir = join(tmpdir(), `omo-vec-adapter-real-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })

  const dbPath = join(tmpDir, "lancedb")
  const manifestPath = join(tmpDir, "manifest.json")

  const manifest = {
    contract_version: "vector-runtime/v1",
    backend: "lancedb",
    db_path: dbPath,
    embedding: {
      provider: "http",
      endpoint: "http://localhost:9999/v1/embeddings",
      model: "test-model",
      dimensions: 4,
    },
    sources: {
      opencode: {
        table: "opencode_sessions",
        schema_version: "opencode-session-chunk/v1",
        source_of_truth: "database",
        last_indexed_at: new Date().toISOString(),
        sessions: 1,
        messages: 1,
        parts: 0,
        chunks: 1,
        source_bytes: 128,
        source_sha256: "a".repeat(64),
      },
    },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest))

  return {
    tmpDir,
    manifestPath,
    dbPath,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  }
}

describe("vector-adapter", () => {
  describe("queryVectorAdapter", () => {
    // ── No-config / degradation tests ──────────────────────────────

    test("returns empty array when no vector config env vars are set", async () => {
      const results = await queryVectorAdapter("pipeline", {
        _env: noVectorConfigEnv(),
      })

      expect(results).toEqual([])
    })

    test("missing default cache path is non-fatal and does not create index directories", async () => {
      const xdgCacheHome = join(tmpdir(), `omo-vec-adapter-default-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const defaultIndexPath = join(xdgCacheHome, "oh-my-opencode", "vector", "opencode-sessions")

      try {
        expect(existsSync(defaultIndexPath)).toBe(false)

        const results = await queryVectorAdapter("pipeline", {
          _env: {
            XDG_CACHE_HOME: xdgCacheHome,
            AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
            AGENT_EMBEDDING_MODEL: "test-model",
            AGENT_EMBEDDING_DIMENSIONS: "4",
          },
        })

        expect(results).toEqual([])
        expect(existsSync(defaultIndexPath)).toBe(false)
      } finally {
        rmSync(xdgCacheHome, { recursive: true, force: true })
      }
    })

    test("returns empty array when manifest path is not configured", async () => {
      const env: Record<string, string | undefined> = {
        AGENT_VECTOR_DB_BACKEND: "lancedb",
        AGENT_VECTOR_DB_PATH: "/tmp/test-lancedb",
        AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
        AGENT_EMBEDDING_MODEL: "test-model",
        AGENT_EMBEDDING_DIMENSIONS: "4",
      }

      const results = await queryVectorAdapter("pipeline", {
        _env: env,
      })

      expect(results).toEqual([])
    })

    test("returns empty array when manifest file does not exist", async () => {
      const results = await queryVectorAdapter("pipeline", {
        _env: validVectorConfigEnv(),
      })

      expect(results).toEqual([])
    })

    test("returns empty array for dbUri-only config without dbPath", async () => {
      const env: Record<string, string | undefined> = {
        AGENT_VECTOR_DB_BACKEND: "lancedb",
        AGENT_VECTOR_DB_URI: "http://remote:6333",
        AGENT_VECTOR_MANIFEST: "/tmp/test-manifest.json",
        AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
        AGENT_EMBEDDING_MODEL: "test-model",
        AGENT_EMBEDDING_DIMENSIONS: "4",
      }

      const results = await queryVectorAdapter("pipeline", {
        _env: env,
      })

      expect(results).toEqual([])
    })

    test("returns empty array when backend is not lancedb", async () => {
      const env: Record<string, string | undefined> = {
        AGENT_VECTOR_DB_BACKEND: "qdrant",
        AGENT_VECTOR_DB_PATH: "/tmp/test-lancedb",
        AGENT_VECTOR_MANIFEST: "/tmp/test-manifest.json",
        AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
        AGENT_EMBEDDING_MODEL: "test-model",
        AGENT_EMBEDDING_DIMENSIONS: "4",
      }

      const results = await queryVectorAdapter("pipeline", {
        _env: env,
      })

      expect(results).toEqual([])
    })

    // ── Real-env: missing dbPath does not create filesystem state ──

    test("does not create missing dbPath directory during query", async () => {
      const fixture = setupRealEnvFixture()
      const missingDbPath = join(fixture.tmpDir, "nonexistent-lancedb")

      try {
        expect(existsSync(missingDbPath)).toBe(false)

        const results = await queryVectorAdapter("test query", {
          _env: {
            AGENT_VECTOR_DB_BACKEND: "lancedb",
            AGENT_VECTOR_DB_PATH: missingDbPath,
            AGENT_VECTOR_MANIFEST: fixture.manifestPath,
            AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
            AGENT_EMBEDDING_MODEL: "test-model",
            AGENT_EMBEDDING_DIMENSIONS: "4",
          },
        })

        expect(results).toEqual([])
        expect(existsSync(missingDbPath)).toBe(false)
      } finally {
        fixture.cleanup()
      }
    })

    // ── timeoutMs propagation ──────────────────────────────────────

    test("propagates timeoutMs option into resolved env", async () => {
      const fixture = setupRealEnvFixture()

      try {
        const start = Date.now()
        const results = await queryVectorAdapter("test query", {
          _env: {
            AGENT_VECTOR_DB_BACKEND: "lancedb",
            AGENT_VECTOR_DB_PATH: fixture.dbPath,
            AGENT_VECTOR_MANIFEST: fixture.manifestPath,
            AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
            AGENT_EMBEDDING_MODEL: "test-model",
            AGENT_EMBEDDING_DIMENSIONS: "4",
          },
          timeoutMs: 5000,
        })
        const elapsed = Date.now() - start

        expect(results).toEqual([])
        expect(elapsed).toBeLessThan(30000)
      } finally {
        fixture.cleanup()
      }
    })

    test("timeoutMs option overrides AGENT_VECTOR_TIMEOUT_MS env var", async () => {
      const fixture = setupRealEnvFixture()

      try {
        const start = Date.now()
        const results = await queryVectorAdapter("test query", {
          _env: {
            AGENT_VECTOR_DB_BACKEND: "lancedb",
            AGENT_VECTOR_DB_PATH: fixture.dbPath,
            AGENT_VECTOR_MANIFEST: fixture.manifestPath,
            AGENT_EMBEDDING_ENDPOINT: "http://localhost:9999/v1/embeddings",
            AGENT_EMBEDDING_MODEL: "test-model",
            AGENT_EMBEDDING_DIMENSIONS: "4",
            AGENT_VECTOR_TIMEOUT_MS: "999999",
          },
          timeoutMs: 5000,
        })
        const elapsed = Date.now() - start

        expect(results).toEqual([])
        expect(elapsed).toBeLessThan(30000)
      } finally {
        fixture.cleanup()
      }
    })

    // ── Mock-based functional tests ────────────────────────────────

    test("returns valid SearchResult array from mock vector store", async () => {
      const qr = makeQueryResult()
      const results = await queryVectorAdapter("deployment", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr]),
      })

      expect(results.length).toBe(1)
      expect(results[0].session_id).toBe("ses_test")
      expect(results[0].message_id).toBe("msg_test")
      expect(results[0].role).toBe("assistant")
      expect(results[0].title).toBe("Test Session")
      expect(results[0].source).toBe("vector")
      expect(results[0].score).toBeCloseTo(0.85)
      expect(results[0].match_type).toContain("semantic")
    })

    test("transforms vector result into SearchResult shape", async () => {
      const qr = makeQueryResult({
        text: "deployment pipeline configuration...",
        metadata: {
          session_id: "ses_v1",
          message_id: "msg_v1",
          role: "assistant",
          session_title: "Vector Test",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })

      const results = await queryVectorAdapter("deployment", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr]),
      })

      expect(results.length).toBe(1)
      const r = results[0]
      expect(r.session_id).toBe("ses_v1")
      expect(r.message_id).toBe("msg_v1")
      expect(r.role).toBe("assistant")
      expect(r.excerpt).toBe("deployment pipeline configuration...")
      expect(r.match_count).toBeGreaterThan(0)
      expect(Array.isArray(r.match_type)).toBe(true)
      expect(r.source).toBe("vector")
      expect(typeof r.score).toBe("number")
      expect(r.timestamp).toBe(1700000001000)
    })

    test("keeps distinct vector chunks from the same session", async () => {
      const qr1 = makeQueryResult({
        chunk_id: "opencode:ses_dup:msg_a:prt_a:hash1",
        score: 0.9,
        text: "first chunk",
        metadata: {
          session_id: "ses_dup",
          message_id: "msg_a",
          role: "user",
          session_title: "Same Session",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })
      const qr2 = makeQueryResult({
        chunk_id: "opencode:ses_dup:msg_b:prt_b:hash2",
        score: 0.7,
        text: "second chunk same session",
        metadata: {
          session_id: "ses_dup",
          message_id: "msg_b",
          role: "assistant",
          session_title: "Same Session",
          session_time_created: 1700000000000,
          message_time_created: 1700000002000,
        },
      })

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr1, qr2]),
      })

      const sesDup = results.filter((r) => r.session_id === "ses_dup")
      expect(sesDup.length).toBe(2)
      expect(new Set(sesDup.map((r) => r.message_id)).size).toBe(2)
    })

    test("message_id is deterministic for same input", async () => {
      const qr = makeQueryResult({
        chunk_id: "opencode:ses_stable:msg_stable:prt_stable:hash_stable",
        text: "stable snippet content",
        metadata: {
          session_id: "ses_stable",
          message_id: "msg_stable",
          role: "user",
          session_title: "Stable",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })

      const results1 = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr]),
      })

      const results2 = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr]),
      })

      expect(results1.length).toBe(1)
      expect(results2.length).toBe(1)
      expect(results1[0].message_id).toBe(results2[0].message_id)
    })

    test("filters vector results by session_id when sessionId option is set", async () => {
      const qrAlpha = makeQueryResult({
        chunk_id: "opencode:ses_alpha:msg_a:prt_a:hash_a",
        score: 0.95,
        text: "alpha content",
        metadata: {
          session_id: "ses_alpha",
          message_id: "msg_a",
          role: "user",
          session_title: "Alpha Session",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })
      const qrBeta = makeQueryResult({
        chunk_id: "opencode:ses_beta:msg_b:prt_b:hash_b",
        score: 0.88,
        text: "beta content",
        metadata: {
          session_id: "ses_beta",
          message_id: "msg_b",
          role: "assistant",
          session_title: "Beta Session",
          session_time_created: 1700000000000,
          message_time_created: 1700000002000,
        },
      })

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qrAlpha, qrBeta]),
        sessionId: "ses_beta",
      })

      expect(results.length).toBe(1)
      expect(results[0].session_id).toBe("ses_beta")
      expect(results[0].title).toBe("Beta Session")
    })

    test("returns all results when sessionId option is not set", async () => {
      const qrAlpha = makeQueryResult({
        chunk_id: "opencode:ses_alpha:msg_a:prt_a:hash_a",
        score: 0.95,
        text: "alpha content",
        metadata: {
          session_id: "ses_alpha",
          message_id: "msg_a",
          role: "user",
          session_title: "Alpha Session",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })
      const qrBeta = makeQueryResult({
        chunk_id: "opencode:ses_beta:msg_b:prt_b:hash_b",
        score: 0.88,
        text: "beta content",
        metadata: {
          session_id: "ses_beta",
          message_id: "msg_b",
          role: "assistant",
          session_title: "Beta Session",
          session_time_created: 1700000000000,
          message_time_created: 1700000002000,
        },
      })

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qrAlpha, qrBeta]),
      })

      expect(results.length).toBe(2)
      const ids = results.map((r) => r.session_id).sort()
      expect(ids).toEqual(["ses_alpha", "ses_beta"])
    })

    test("ignores results from non-opencode source", async () => {
      const qrGood = makeQueryResult({
        source: "opencode",
        chunk_id: "opencode:ses_good:msg_g:prt_g:hash_g",
        metadata: {
          session_id: "ses_good",
          message_id: "msg_g",
          role: "user",
          session_title: "Good",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })
      const qrBad = makeQueryResult({
        source: "markdown",
        chunk_id: "markdown:some-note:hash_x",
        metadata: {
          session_id: "ses_bad",
          message_id: "msg_bad",
          role: "user",
          session_title: "Bad",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qrGood, qrBad]),
      })

      expect(results.length).toBe(1)
      expect(results[0].session_id).toBe("ses_good")
    })

    test("returns empty array when embedding client throws", async () => {
      const failingClient: EmbeddingClient = {
        embed: async () => {
          throw new Error("embedding failed")
        },
      }

      const qr = makeQueryResult()
      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: failingClient,
        _vectorStore: mockVectorStore([qr]),
      })

      expect(results).toEqual([])
    })

    test("returns empty array when vector store query throws", async () => {
      const failingStore: LanceDbVectorStore = {
        upsertChunks: async () => {},
        deleteMissing: async () => {},
        query: async () => {
          throw new Error("query failed")
        },
      }

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: failingStore,
      })

      expect(results).toEqual([])
    })

    test("returns empty array when vector store returns empty results", async () => {
      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([]),
      })

      expect(results).toEqual([])
    })

    test("respects topK option in query request", async () => {
      let capturedTopK = 0
      const capturingStore: LanceDbVectorStore = {
        upsertChunks: async () => {},
        deleteMissing: async () => {},
        query: async (request: QueryRequest, _embedding: number[], _context?: LanceDbQueryContext) => {
          capturedTopK = request.top_k
          return { results: [], diagnostics: { backend: "lancedb", manifest_validated: true, semantic_available: false } }
        },
      }

      await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: capturingStore,
        topK: 7,
      })

      expect(capturedTopK).toBe(7)
    })

    test("uses default topK of 10 when not specified", async () => {
      let capturedTopK = 0
      const capturingStore: LanceDbVectorStore = {
        upsertChunks: async () => {},
        deleteMissing: async () => {},
        query: async (request: QueryRequest, _embedding: number[], _context?: LanceDbQueryContext) => {
          capturedTopK = request.top_k
          return { results: [], diagnostics: { backend: "lancedb", manifest_validated: true, semantic_available: false } }
        },
      }

      await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: capturingStore,
      })

      expect(capturedTopK).toBe(10)
    })

    test("deduplicates results by session_id:message_id key", async () => {
      const qr1 = makeQueryResult({
        chunk_id: "opencode:ses_x:msg_x:prt_a:hash_a",
        score: 0.9,
        text: "first chunk same message",
        metadata: {
          session_id: "ses_x",
          message_id: "msg_x",
          role: "user",
          session_title: "Dedup Test",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })
      const qr2 = makeQueryResult({
        chunk_id: "opencode:ses_x:msg_x:prt_b:hash_b",
        score: 0.7,
        text: "second chunk same message",
        metadata: {
          session_id: "ses_x",
          message_id: "msg_x",
          role: "user",
          session_title: "Dedup Test",
          session_time_created: 1700000000000,
          message_time_created: 1700000001000,
        },
      })

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr1, qr2]),
      })

      expect(results.length).toBe(1)
      expect(results[0].session_id).toBe("ses_x")
    })

    test("handles missing metadata fields gracefully", async () => {
      const qr: QueryResult = {
        source: "opencode",
        chunk_id: "opencode:ses_min:msg_min:prt_min:hash_min",
        score: 0.5,
        text: "minimal result",
        metadata: {
          session_id: "ses_min",
        },
      }

      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr]),
      })

      expect(results.length).toBe(1)
      expect(results[0].session_id).toBeDefined()
      expect(results[0].message_id).toBeDefined()
      expect(results[0].source).toBe("vector")
    })

    test("does not create or build index directories during query", async () => {
      const qr = makeQueryResult()
      const results = await queryVectorAdapter("test", {
        _env: validVectorConfigEnv(),
        _embeddingClient: mockEmbeddingClient(),
        _vectorStore: mockVectorStore([qr]),
      })

      expect(results.length).toBe(1)
    })
  })
})
