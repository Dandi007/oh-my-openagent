import { afterEach, describe, expect, it } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLanceDbVectorStore,
  type LanceDbChunkInput,
} from "./lancedb-adapter"
import type { QueryRequest } from "./types"

const TEST_DB_PATHS: string[] = []

function tempDbPath(label: string): string {
  const path = join(
    tmpdir(),
    `lancedb-adapter-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  TEST_DB_PATHS.push(path)
  return path
}

function chunk(
  overrides: Partial<LanceDbChunkInput> & Pick<LanceDbChunkInput, "chunk_id" | "embedding" | "text">,
): LanceDbChunkInput {
  return {
    source: "docs",
    schema_version: "test-chunk/v1",
    chunk_hash: `hash-${overrides.chunk_id}`,
    metadata: {},
    updated_at: "2026-05-12T12:00:00.000Z",
    ...overrides,
  }
}

function queryRequest(overrides?: Partial<QueryRequest>): QueryRequest {
  return {
    query: "alpha",
    source: "docs",
    mode: "semantic",
    top_k: 10,
    ...overrides,
  }
}

describe("createLanceDbVectorStore", () => {
  afterEach(() => {
    for (const path of TEST_DB_PATHS.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  // #given deterministic vectors stored through the LanceDB adapter
  // #when a semantic query runs with top_k=2
  // #then closest chunks are returned first and normalized into QueryResponse
  it("upserts chunks and queries topK results in nearest-neighbor order", async () => {
    const store = createLanceDbVectorStore({
      dbPath: tempDbPath("ordering"),
      tableName: "chunks",
    })

    await store.upsertChunks([
      chunk({ chunk_id: "alpha", text: "alpha text", embedding: [1, 0, 0] }),
      chunk({ chunk_id: "beta", text: "beta text", embedding: [0, 1, 0] }),
      chunk({ chunk_id: "gamma", text: "gamma text", embedding: [0, 0, 1] }),
    ])

    const response = await store.query(queryRequest({ top_k: 2 }), [0.95, 0.05, 0], {
      manifestValidated: true,
    })

    expect(response.diagnostics).toEqual({
      backend: "lancedb",
      manifest_validated: true,
      semantic_available: true,
    })
    expect(response.results.map((r) => r.chunk_id)).toEqual(["alpha", "beta"])
    expect(response.results[0].source).toBe("docs")
    expect(response.results[0].text).toBe("alpha text")
    expect(response.results[0].score).toBeGreaterThanOrEqual(response.results[1].score)
  })

  // #given chunks with structured protocol metadata
  // #when the adapter returns semantic results
  // #then metadata is preserved on QueryResult rows
  it("preserves protocol metadata in query results", async () => {
    const store = createLanceDbVectorStore({
      dbPath: tempDbPath("metadata"),
      tableName: "chunks",
    })

    await store.upsertChunks([
      chunk({
        chunk_id: "with-metadata",
        text: "metadata text",
        embedding: [1, 0, 0],
        metadata: {
          session_id: "ses_123",
          message_index: 7,
          tags: ["alpha", "runtime"],
        },
      }),
    ])

    const response = await store.query(queryRequest({ top_k: 1 }), [1, 0, 0])

    expect(response.results).toHaveLength(1)
    expect(response.results[0].metadata).toEqual({
      session_id: "ses_123",
      message_index: 7,
      tags: ["alpha", "runtime"],
    })
  })

  // #given chunks from multiple source namespaces in one LanceDB table
  // #when querying one source
  // #then rows from other sources are filtered out before topK limiting
  it("filters query results by request source", async () => {
    const store = createLanceDbVectorStore({
      dbPath: tempDbPath("source-filter"),
      tableName: "chunks",
    })

    await store.upsertChunks([
      chunk({
        source: "other",
        chunk_id: "other-closer",
        text: "other source text",
        embedding: [1, 0, 0],
      }),
      chunk({
        source: "docs",
        chunk_id: "docs-match",
        text: "docs text",
        embedding: [0.9, 0.1, 0],
      }),
    ])

    const response = await store.query(queryRequest({ top_k: 1 }), [1, 0, 0])

    expect(response.results.map((r) => r.chunk_id)).toEqual(["docs-match"])
    expect(response.results[0].source).toBe("docs")
  })

  // #given an indexed source with stale chunks
  // #when deleteMissing is called with the current chunk ids
  // #then stale chunks for that source are removed without deleting other sources
  it("deleteMissing removes stale source chunks and keeps listed chunks", async () => {
    const store = createLanceDbVectorStore({
      dbPath: tempDbPath("delete-missing"),
      tableName: "chunks",
    })

    await store.upsertChunks([
      chunk({ chunk_id: "keep", text: "keep text", embedding: [1, 0, 0] }),
      chunk({ chunk_id: "delete", text: "delete text", embedding: [0, 1, 0] }),
      chunk({
        source: "other",
        chunk_id: "other-keep",
        text: "other keep text",
        embedding: [0, 1, 0],
      }),
    ])

    await store.deleteMissing("docs", ["keep"])

    const docsResponse = await store.query(queryRequest({ top_k: 10 }), [1, 0, 0])
    const otherResponse = await store.query(
      queryRequest({ source: "other", top_k: 10 }),
      [0, 1, 0],
    )

    expect(docsResponse.results.map((r) => r.chunk_id)).toEqual(["keep"])
    expect(otherResponse.results.map((r) => r.chunk_id)).toEqual(["other-keep"])
  })

  // #given an adapter pointed at an empty LanceDB directory
  // #when query runs before any table/index exists
  // #then it returns empty semantic results and explicit diagnostics
  it("returns controlled diagnostics when the vector table is missing", async () => {
    const store = createLanceDbVectorStore({
      dbPath: tempDbPath("missing-table"),
      tableName: "chunks",
    })

    const response = await store.query(queryRequest(), [1, 0, 0], {
      manifestValidated: true,
    })

    expect(response.results).toEqual([])
    expect(response.diagnostics).toEqual({
      backend: "lancedb",
      manifest_validated: true,
      semantic_available: false,
      reason: "vector_index_missing",
    })
  })

  // #given an adapter pointed at an empty LanceDB directory
  // #when missing-index query is repeated
  // #then query did not implicitly create the table on the first attempt
  it("does not implicitly create tables during query", async () => {
    const store = createLanceDbVectorStore({
      dbPath: tempDbPath("no-query-create"),
      tableName: "chunks",
    })

    const first = await store.query(queryRequest(), [1, 0, 0])
    const second = await store.query(queryRequest(), [1, 0, 0])

    expect(first.diagnostics.reason).toBe("vector_index_missing")
    expect(second.diagnostics.reason).toBe("vector_index_missing")
    expect(second.results).toEqual([])
  })
})
