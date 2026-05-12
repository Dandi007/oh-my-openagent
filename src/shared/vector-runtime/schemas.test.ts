import { describe, expect, it } from "bun:test"
import {
  ManifestSchema,
  ManifestSourceSchema,
  QueryRequestSchema,
  QueryResponseSchema,
  RuntimeDiagnosticsSchema,
} from "./schemas"

// ── Shared Fixtures ───────────────────────────────────────────────────

const validManifestSource = {
  table: "opencode_sessions",
  schema_version: "opencode-session-chunk/v1",
  source_of_truth: "database",
  last_indexed_at: "2026-05-12T00:00:00+08:00",
}

const validManifest = {
  contract_version: "vector-runtime/v1" as const,
  backend: "lancedb" as const,
  db_path: "/vector-store",
  embedding: {
    provider: "http",
    endpoint: "http://example.internal/v1/embeddings",
    model: "BAAI/bge-small-zh-v1.5",
    dimensions: 512,
  },
  sources: {
    opencode: validManifestSource,
    markdown: {
      table: "chunks",
      schema_version: "markdown-chunk/v1",
      source_of_truth: "external-system",
      last_indexed_at: "2026-05-12T00:00:00+08:00",
    },
  },
}

const validQueryRequest = {
  query: "DeepSeek ksyun training",
  source: "opencode",
  mode: "semantic" as const,
  top_k: 10,
}

const validQueryResponse = {
  results: [
    {
      source: "opencode",
      chunk_id: "session:message:hash",
      score: 0.87,
      text: "matched chunk text",
      metadata: {
        session_id: "ses_xxx",
        message_id: "msg_xxx",
        title: "Session title",
      },
    },
  ],
  diagnostics: {
    backend: "lancedb" as const,
    manifest_validated: true,
    semantic_available: true,
  },
}

// ── ManifestSourceSchema ──────────────────────────────────────────────

describe("ManifestSourceSchema", () => {
  // #given a valid manifest source object
  // #when parsed by ManifestSourceSchema
  // #then it succeeds
  it("accepts a valid source entry", () => {
    const result = ManifestSourceSchema.safeParse(validManifestSource)
    expect(result.success).toBe(true)
  })

  // #given a source entry missing the table field
  // #when parsed by ManifestSourceSchema
  // #then it fails
  it("rejects a source entry missing table", () => {
    const { table: _, ...missing } = validManifestSource
    const result = ManifestSourceSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a source entry missing schema_version
  // #when parsed by ManifestSourceSchema
  // #then it fails
  it("rejects a source entry missing schema_version", () => {
    const { schema_version: _, ...missing } = validManifestSource
    const result = ManifestSourceSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a source entry missing source_of_truth
  // #when parsed by ManifestSourceSchema
  // #then it fails
  it("rejects a source entry missing source_of_truth", () => {
    const { source_of_truth: _, ...missing } = validManifestSource
    const result = ManifestSourceSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a source entry missing last_indexed_at
  // #when parsed by ManifestSourceSchema
  // #then it fails
  it("rejects a source entry missing last_indexed_at", () => {
    const { last_indexed_at: _, ...missing } = validManifestSource
    const result = ManifestSourceSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a source entry with empty table string
  // #when parsed by ManifestSourceSchema
  // #then it fails
  it("rejects empty table string", () => {
    const result = ManifestSourceSchema.safeParse({
      ...validManifestSource,
      table: "",
    })
    expect(result.success).toBe(false)
  })

  // #given a source entry with extra unknown fields
  // #when parsed by ManifestSourceSchema (strict)
  // #then it fails
  it("rejects extra unknown fields", () => {
    const result = ManifestSourceSchema.safeParse({
      ...validManifestSource,
      extra_field: "should not be here",
    })
    expect(result.success).toBe(false)
  })

  // #given a source entry with source_of_truth not in approved enum
  // #when parsed by ManifestSourceSchema
  // #then it fails
  it("rejects source_of_truth not in approved enum", () => {
    const result = ManifestSourceSchema.safeParse({
      ...validManifestSource,
      source_of_truth: "filesystem",
    })
    expect(result.success).toBe(false)
  })

  // #given a source entry with source_of_truth "opencode.db"
  // #when parsed by ManifestSourceSchema
  // #then it fails (not in approved enum)
  it("rejects source_of_truth with consumer-specific value", () => {
    const result = ManifestSourceSchema.safeParse({
      ...validManifestSource,
      source_of_truth: "opencode.db",
    })
    expect(result.success).toBe(false)
  })

  // #given a source entry with source_of_truth "external-system"
  // #when parsed by ManifestSourceSchema
  // #then it succeeds
  it("accepts source_of_truth external-system", () => {
    const result = ManifestSourceSchema.safeParse({
      ...validManifestSource,
      source_of_truth: "external-system",
    })
    expect(result.success).toBe(true)
  })
})

// ── ManifestSchema ────────────────────────────────────────────────────

describe("ManifestSchema", () => {
  // #given a valid manifest object matching the contract spec
  // #when parsed by ManifestSchema
  // #then it succeeds
  it("accepts a valid manifest", () => {
    const result = ManifestSchema.safeParse(validManifest)
    expect(result.success).toBe(true)
  })

  // #given a manifest with an invalid contract_version
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects invalid contract_version", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      contract_version: "vector-runtime/v2",
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with a missing contract_version
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects missing contract_version", () => {
    const { contract_version: _, ...missing } = validManifest
    const result = ManifestSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a manifest with an unsupported backend
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects unsupported backend", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      backend: "pinecone",
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with zero embedding dimensions
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects zero embedding dimensions", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      embedding: { ...validManifest.embedding, dimensions: 0 },
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with negative embedding dimensions
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects negative embedding dimensions", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      embedding: { ...validManifest.embedding, dimensions: -1 },
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with non-integer embedding dimensions
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects non-integer embedding dimensions", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      embedding: { ...validManifest.embedding, dimensions: 3.14 },
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with empty sources record
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects empty sources record", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      sources: {},
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with a malformed source entry
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects malformed source entry", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      sources: {
        opencode: { table: "x" },
      },
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with extra unknown top-level fields
  // #when parsed by ManifestSchema (strict)
  // #then it fails
  it("rejects extra unknown top-level fields", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest,
      extra: "nope",
    })
    expect(result.success).toBe(false)
  })

  // #given a manifest with missing db_path
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects missing db_path", () => {
    const { db_path: _, ...missing } = validManifest
    const result = ManifestSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a manifest with missing embedding
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects missing embedding", () => {
    const { embedding: _, ...missing } = validManifest
    const result = ManifestSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })

  // #given a manifest with missing sources
  // #when parsed by ManifestSchema
  // #then it fails
  it("rejects missing sources", () => {
    const { sources: _, ...missing } = validManifest
    const result = ManifestSchema.safeParse(missing)
    expect(result.success).toBe(false)
  })
})

// ── QueryRequestSchema ────────────────────────────────────────────────

describe("QueryRequestSchema", () => {
  // #given a valid query request
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts a valid query request", () => {
    const result = QueryRequestSchema.safeParse(validQueryRequest)
    expect(result.success).toBe(true)
  })

  // #given a query request with mode=semantic
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts semantic mode", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      mode: "semantic",
    })
    expect(result.success).toBe(true)
  })

  // #given a query request with mode=keyword
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts keyword mode", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      mode: "keyword",
    })
    expect(result.success).toBe(true)
  })

  // #given a query request with mode=hybrid
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts hybrid mode", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      mode: "hybrid",
    })
    expect(result.success).toBe(true)
  })

  // #given a query request with optional filters
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts optional filters", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      filters: { session_id: "ses_abc" },
    })
    expect(result.success).toBe(true)
  })

  // #given a query request without filters
  // #when parsed by QueryRequestSchema
  // #then it succeeds (filters are optional)
  it("accepts missing filters", () => {
    const noFilters = {
      query: validQueryRequest.query,
      source: validQueryRequest.source,
      mode: validQueryRequest.mode,
      top_k: validQueryRequest.top_k,
    }
    const result = QueryRequestSchema.safeParse(noFilters)
    expect(result.success).toBe(true)
  })

  // #given a query request with an invalid mode
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects invalid query mode", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      mode: "fulltext",
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with top_k=0
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects top_k of zero", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      top_k: 0,
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with negative top_k
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects negative top_k", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      top_k: -5,
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with top_k exceeding the upper bound
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects top_k exceeding upper bound", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      top_k: 101,
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with top_k at the upper bound
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts top_k at upper bound (100)", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      top_k: 100,
    })
    expect(result.success).toBe(true)
  })

  // #given a query request with top_k=1
  // #when parsed by QueryRequestSchema
  // #then it succeeds
  it("accepts top_k of 1", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      top_k: 1,
    })
    expect(result.success).toBe(true)
  })

  // #given a query request with empty query string
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects empty query string", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      query: "",
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with empty source string
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects empty source string", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      source: "",
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with non-integer top_k
  // #when parsed by QueryRequestSchema
  // #then it fails
  it("rejects non-integer top_k", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      top_k: 5.5,
    })
    expect(result.success).toBe(false)
  })

  // #given a query request with extra unknown fields
  // #when parsed by QueryRequestSchema (strict)
  // #then it fails
  it("rejects extra unknown fields", () => {
    const result = QueryRequestSchema.safeParse({
      ...validQueryRequest,
      extra: "nope",
    })
    expect(result.success).toBe(false)
  })
})

// ── RuntimeDiagnosticsSchema ──────────────────────────────────────────

describe("RuntimeDiagnosticsSchema", () => {
  // #given valid runtime diagnostics
  // #when parsed by RuntimeDiagnosticsSchema
  // #then it succeeds
  it("accepts valid diagnostics", () => {
    const result = RuntimeDiagnosticsSchema.safeParse({
      backend: "lancedb",
      manifest_validated: true,
      semantic_available: true,
    })
    expect(result.success).toBe(true)
  })

  // #given diagnostics with manifest_validated=false
  // #when parsed by RuntimeDiagnosticsSchema
  // #then it succeeds
  it("accepts manifest_validated false", () => {
    const result = RuntimeDiagnosticsSchema.safeParse({
      backend: "noop",
      manifest_validated: false,
      semantic_available: false,
    })
    expect(result.success).toBe(true)
  })

  // #given diagnostics with invalid backend
  // #when parsed by RuntimeDiagnosticsSchema
  // #then it fails
  it("rejects invalid backend", () => {
    const result = RuntimeDiagnosticsSchema.safeParse({
      backend: "invalid",
      manifest_validated: true,
      semantic_available: true,
    })
    expect(result.success).toBe(false)
  })

  // #given diagnostics with missing manifest_validated
  // #when parsed by RuntimeDiagnosticsSchema
  // #then it fails
  it("rejects missing manifest_validated", () => {
    const result = RuntimeDiagnosticsSchema.safeParse({
      backend: "lancedb",
      semantic_available: true,
    })
    expect(result.success).toBe(false)
  })

  // #given diagnostics with extra unknown fields
  // #when parsed by RuntimeDiagnosticsSchema (strict)
  // #then it fails
  it("rejects extra unknown fields", () => {
    const result = RuntimeDiagnosticsSchema.safeParse({
      backend: "lancedb",
      manifest_validated: true,
      semantic_available: true,
      api_key: "secret-leak",
    })
    expect(result.success).toBe(false)
  })
})

// ── QueryResponseSchema ───────────────────────────────────────────────

describe("QueryResponseSchema", () => {
  // #given a valid query response
  // #when parsed by QueryResponseSchema
  // #then it succeeds
  it("accepts a valid query response", () => {
    const result = QueryResponseSchema.safeParse(validQueryResponse)
    expect(result.success).toBe(true)
  })

  // #given a query response with empty results array
  // #when parsed by QueryResponseSchema
  // #then it succeeds
  it("accepts empty results array", () => {
    const result = QueryResponseSchema.safeParse({
      results: [],
      diagnostics: {
        backend: "noop",
        manifest_validated: false,
        semantic_available: false,
      },
    })
    expect(result.success).toBe(true)
  })

  // #given a query response with a result missing chunk_id
  // #when parsed by QueryResponseSchema
  // #then it fails
  it("rejects result missing chunk_id", () => {
    const result = QueryResponseSchema.safeParse({
      results: [
        {
          source: "opencode",
          score: 0.5,
          text: "text",
          metadata: {},
        },
      ],
      diagnostics: {
        backend: "lancedb",
        manifest_validated: true,
        semantic_available: true,
      },
    })
    expect(result.success).toBe(false)
  })

  // #given a query response with score out of range
  // #when parsed by QueryResponseSchema
  // #then it fails
  it("rejects result score above 1", () => {
    const result = QueryResponseSchema.safeParse({
      results: [
        {
          source: "opencode",
          chunk_id: "id",
          score: 1.5,
          text: "text",
          metadata: {},
        },
      ],
      diagnostics: {
        backend: "lancedb",
        manifest_validated: true,
        semantic_available: true,
      },
    })
    expect(result.success).toBe(false)
  })

  // #given a query response with negative score
  // #when parsed by QueryResponseSchema
  // #then it fails
  it("rejects negative result score", () => {
    const result = QueryResponseSchema.safeParse({
      results: [
        {
          source: "opencode",
          chunk_id: "id",
          score: -0.1,
          text: "text",
          metadata: {},
        },
      ],
      diagnostics: {
        backend: "lancedb",
        manifest_validated: true,
        semantic_available: true,
      },
    })
    expect(result.success).toBe(false)
  })

  // #given a query response with missing diagnostics
  // #when parsed by QueryResponseSchema
  // #then it fails
  it("rejects missing diagnostics", () => {
    const result = QueryResponseSchema.safeParse({
      results: [],
    })
    expect(result.success).toBe(false)
  })

  // #given a query response with extra unknown fields
  // #when parsed by QueryResponseSchema (strict)
  // #then it fails
  it("rejects extra unknown fields", () => {
    const result = QueryResponseSchema.safeParse({
      ...validQueryResponse,
      extra: "nope",
    })
    expect(result.success).toBe(false)
  })
})