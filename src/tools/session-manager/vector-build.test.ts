import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EmbeddingClient } from "../../shared/vector-runtime/embedding-client"
import {
  createLanceDbVectorStore,
  type LanceDbChunkInput,
  type LanceDbVectorStore,
} from "../../shared/vector-runtime/lancedb-adapter"
import type { QueryRequest, QueryResponse, SourceNamespace } from "../../shared/vector-runtime/types"
import { buildOpenCodeSessionVectorIndex } from "./vector-build"

const CLEANUP_PATHS: string[] = []

function tempPath(label: string, suffix: string): string {
  const path = join(
    tmpdir(),
    `omo-vector-build-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  )
  CLEANUP_PATHS.push(path)
  return path
}

function checksum(path: string): { bytes: number; sha256: string } {
  const bytes = readFileSync(path)
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function createFixtureDb(label: string): string {
  const dbPath = tempPath(label, ".db")
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode=DELETE")
  db.run("PRAGMA foreign_keys=ON")

  db.run(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    )
  `)

  const now = 1_777_000_000_000
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_alpha", "proj_1", "alpha", "/workspace/proj", "Vector build fixture", "1.0", now - 1000, now],
  )

  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "msg_user",
      "ses_alpha",
      now - 900,
      now - 850,
      JSON.stringify({ role: "user", prompt: "Message prompt should be indexed" }),
    ],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "msg_assistant",
      "ses_alpha",
      now - 800,
      now - 700,
      JSON.stringify({ role: "assistant", description: "Message description should be indexed" }),
    ],
  )

  const parts: Array<[string, string, string, number, Record<string, unknown>]> = [
    ["prt_text", "msg_user", "ses_alpha", now - 890, { type: "text", text: "Kubernetes deployment pipeline text" }],
    ["prt_thinking", "msg_assistant", "ses_alpha", now - 790, { type: "thinking", thinking: "Need multistage Docker thinking" }],
    ["prt_reasoning", "msg_assistant", "ses_alpha", now - 780, { type: "reasoning", reasoning: "Reasoning text should be indexed" }],
    ["prt_reasoning_obj", "msg_assistant", "ses_alpha", now - 770, { type: "reasoning", reasoning: { text: "Nested reasoning object text" } }],
    ["prt_tool", "msg_assistant", "ses_alpha", now - 760, { type: "tool", state: { title: "Tool state title", output: "Tool state output" } }],
    ["prt_empty", "msg_assistant", "ses_alpha", now - 750, { type: "tool", input: { command: "pwd" } }],
  ]

  for (const [id, messageId, sessionId, time, data] of parts) {
    db.run(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, messageId, sessionId, time, time, JSON.stringify(data)],
    )
  }

  db.close()
  return dbPath
}

function createMultiSessionFixtureDb(label: string): string {
  const dbPath = tempPath(label, ".db")
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode=DELETE")
  db.run("PRAGMA foreign_keys=ON")

  db.run(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    )
  `)

  const now = 1_777_000_000_000

  // Session A (ses_aaa — sorts first)
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_aaa", "proj_1", "aaa", "/workspace/a", "Session AAA", "1.0", now - 2000, now - 1000],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_aaa_1", "ses_aaa", now - 1900, now - 1850, JSON.stringify({ role: "user", text: "AAA message one" })],
  )

  // Session B (ses_bbb — sorts second)
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_bbb", "proj_1", "bbb", "/workspace/b", "Session BBB", "1.0", now - 1500, now - 500],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_bbb_1", "ses_bbb", now - 1400, now - 1350, JSON.stringify({ role: "user", text: "BBB message one" })],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_bbb_2", "ses_bbb", now - 1300, now - 1250, JSON.stringify({ role: "assistant", text: "BBB message two" })],
  )

  // Session C (ses_ccc — sorts third)
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_ccc", "proj_1", "ccc", "/workspace/c", "Session CCC", "1.0", now - 1000, now],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_ccc_1", "ses_ccc", now - 900, now - 850, JSON.stringify({ role: "user", text: "CCC message one" })],
  )

  db.close()
  return dbPath
}

class ConstantEmbeddingClient implements EmbeddingClient {
  readonly calls: string[][] = []

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts])
    return texts.map(() => [1, 0, 0])
  }
}

class CapturingVectorStore implements LanceDbVectorStore {
  readonly upserted: LanceDbChunkInput[] = []
  readonly deleteMissingCalls: Array<{ source: SourceNamespace; currentChunkIds: string[] }> = []

  async upsertChunks(chunks: LanceDbChunkInput[]): Promise<void> {
    this.upserted.push(...chunks)
  }

  async deleteMissing(source: SourceNamespace, currentChunkIds: string[]): Promise<void> {
    this.deleteMissingCalls.push({ source, currentChunkIds: [...currentChunkIds] })
  }

  async query(_request: QueryRequest, _embedding: number[]): Promise<QueryResponse> {
    return {
      results: [],
      diagnostics: {
        backend: "lancedb",
        manifest_validated: true,
        semantic_available: true,
      },
    }
  }
}

afterEach(() => {
  for (const path of CLEANUP_PATHS.splice(0)) {
    if (path.endsWith(".db") || path.endsWith(".json")) {
      if (existsSync(path)) unlinkSync(path)
    } else {
      rmSync(path, { recursive: true, force: true })
    }
  }
})

describe("buildOpenCodeSessionVectorIndex", () => {
  // #given an OpenCode SQLite fixture and an injected fake embedding client
  // #when the explicit vector build runs
  // #then it extracts supported session chunks, writes derived rows, writes manifest data, and preserves source bytes
  test("builds protocol-compatible chunks and manifest without mutating source DB", async () => {
    const sourceDbPath = createFixtureDb("manifest")
    const before = checksum(sourceDbPath)
    const manifestPath = tempPath("manifest", ".json")
    const vectorStore = new CapturingVectorStore()
    const embeddingClient = new ConstantEmbeddingClient()

    const result = await buildOpenCodeSessionVectorIndex({
      sourceDbPath,
      vectorDbPath: tempPath("captured-vector", ""),
      manifestPath,
      embeddingClient,
      vectorStore,
      embedding: {
        provider: "fake",
        endpoint: "fake://embedding",
        model: "fake-model",
        dimensions: 3,
      },
      now: () => new Date("2026-05-12T12:34:56.000Z"),
    })

    const after = checksum(sourceDbPath)

    expect(after).toEqual(before)
    expect(result.sourceDbBefore).toEqual(before)
    expect(result.sourceDbAfter).toEqual(before)
    expect(result.stats).toEqual({
      sessions: 1,
      messages: 2,
      parts: 6,
      chunks: 7,
      source_bytes: before.bytes,
      source_sha256: before.sha256,
    })
    expect(embeddingClient.calls).toHaveLength(1)
    expect(embeddingClient.calls[0]).toContain("Kubernetes deployment pipeline text")
    expect(embeddingClient.calls[0]).toContain("Need multistage Docker thinking")
    expect(embeddingClient.calls[0]).toContain("Reasoning text should be indexed")
    expect(embeddingClient.calls[0]).toContain("Nested reasoning object text")
    expect(embeddingClient.calls[0]).toContain("Tool state title | Tool state output")
    expect(embeddingClient.calls[0]).toContain("Message prompt should be indexed")
    expect(embeddingClient.calls[0]).toContain("Message description should be indexed")

    expect(vectorStore.upserted).toHaveLength(7)
    expect(vectorStore.upserted.every((row) => row.source === "opencode")).toBe(true)
    expect(vectorStore.upserted.every((row) => row.schema_version === "opencode-session-chunk/v1")).toBe(true)
    expect(vectorStore.upserted.every((row) => row.embedding.length === 3)).toBe(true)
    expect(vectorStore.deleteMissingCalls).toEqual([
      {
        source: "opencode",
        currentChunkIds: vectorStore.upserted.map((row) => row.chunk_id),
      },
    ])

    const textRow = vectorStore.upserted.find((row) => row.text === "Kubernetes deployment pipeline text")
    expect(textRow).toBeDefined()
    expect(textRow?.metadata).toMatchObject({
      session_id: "ses_alpha",
      message_id: "msg_user",
      part_id: "prt_text",
      role: "user",
      session_title: "Vector build fixture",
    })

    const writtenManifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    expect(writtenManifest).toEqual(result.manifest)
    expect(result.manifest.sources.opencode).toEqual({
      table: "opencode_sessions",
      schema_version: "opencode-session-chunk/v1",
      source_of_truth: "database",
      last_indexed_at: "2026-05-12T12:34:56.000Z",
      sessions: 1,
      messages: 2,
      parts: 6,
      chunks: 7,
      source_bytes: before.bytes,
      source_sha256: before.sha256,
    })
  })

  // #given identical SQLite source records and content
  // #when the full rebuild runs twice
  // #then chunk IDs stay deterministic and use the required opencode ID format
  test("generates deterministic chunk IDs across rebuilds", async () => {
    const sourceDbPath = createFixtureDb("deterministic")

    const firstStore = new CapturingVectorStore()
    const secondStore = new CapturingVectorStore()
    const options = {
      sourceDbPath,
      vectorDbPath: tempPath("deterministic-vector", ""),
      manifestPath: tempPath("deterministic-manifest", ".json"),
      embeddingClient: new ConstantEmbeddingClient(),
      embedding: {
        provider: "fake",
        endpoint: "fake://embedding",
        model: "fake-model",
        dimensions: 3,
      },
      now: () => new Date("2026-05-12T12:34:56.000Z"),
    }

    await buildOpenCodeSessionVectorIndex({ ...options, vectorStore: firstStore })
    await buildOpenCodeSessionVectorIndex({ ...options, vectorStore: secondStore })

    const firstIds = firstStore.upserted.map((row) => row.chunk_id).sort()
    const secondIds = secondStore.upserted.map((row) => row.chunk_id).sort()

    expect(secondIds).toEqual(firstIds)
    expect(firstIds.every((id) => /^opencode:ses_alpha:msg_(user|assistant):[A-Za-z0-9_-]+:[a-f0-9]{64}$/.test(id))).toBe(true)
  })

  // #given a LanceDB-backed derived store with a stale opencode row
  // #when a full rebuild is applied through the adapter
  // #then stale rows are removed and current session chunks are queryable through the adapter
  test("writes current rows to LanceDB adapter and deletes stale opencode chunks", async () => {
    const sourceDbPath = createFixtureDb("lancedb")
    const vectorDbPath = tempPath("real-vector", "")
    const store = createLanceDbVectorStore({ dbPath: vectorDbPath, tableName: "opencode_sessions" })
    await store.upsertChunks([
      {
        source: "opencode",
        chunk_id: "opencode:stale:msg:part:hash",
        text: "stale row should disappear",
        metadata: { stale: true },
        schema_version: "opencode-session-chunk/v1",
        chunk_hash: "hash",
        embedding: [1, 0, 0],
        updated_at: "2026-05-12T00:00:00.000Z",
      },
    ])

    await buildOpenCodeSessionVectorIndex({
      sourceDbPath,
      vectorDbPath,
      manifestPath: tempPath("real-manifest", ".json"),
      embeddingClient: new ConstantEmbeddingClient(),
      embedding: {
        provider: "fake",
        endpoint: "fake://embedding",
        model: "fake-model",
        dimensions: 3,
      },
      now: () => new Date("2026-05-12T12:34:56.000Z"),
    })

    const response = await store.query(
      {
        query: "session chunks",
        source: "opencode",
        mode: "semantic",
        top_k: 20,
      },
      [1, 0, 0],
      { manifestValidated: true },
    )

    expect(response.diagnostics.semantic_available).toBe(true)
    expect(response.results).toHaveLength(7)
    expect(response.results.some((row) => row.text === "stale row should disappear")).toBe(false)
    expect(response.results.map((row) => row.text)).toContain("Tool state title | Tool state output")
  })

  // #given a multi-session fixture with 3 sessions (ses_aaa, ses_bbb, ses_ccc)
  // #when limitSessions=1 is passed
  // #then only chunks from the first session (ses_aaa) are indexed
  test("limitSessions restricts indexing to the first N sessions in deterministic order", async () => {
    const sourceDbPath = createMultiSessionFixtureDb("limit")
    const before = checksum(sourceDbPath)
    const vectorStore = new CapturingVectorStore()

    const result = await buildOpenCodeSessionVectorIndex({
      sourceDbPath,
      vectorDbPath: tempPath("limit-vector", ""),
      manifestPath: tempPath("limit-manifest", ".json"),
      embeddingClient: new ConstantEmbeddingClient(),
      vectorStore,
      embedding: {
        provider: "fake",
        endpoint: "fake://embedding",
        model: "fake-model",
        dimensions: 3,
      },
      limitSessions: 1,
      now: () => new Date("2026-05-12T12:34:56.000Z"),
    })

    const after = checksum(sourceDbPath)
    expect(after).toEqual(before)

    // Stats report total counts (not limited), but chunks are limited
    expect(result.stats.sessions).toBe(3)
    expect(result.stats.messages).toBe(4)
    expect(result.stats.parts).toBe(0)
    expect(result.stats.chunks).toBe(1) // only ses_aaa's one message

    // All chunks must belong to ses_aaa only
    const sessionIds = vectorStore.upserted.map((row) => row.metadata.session_id)
    expect(sessionIds.every((id) => id === "ses_aaa")).toBe(true)
    expect(vectorStore.upserted.some((row) => row.text === "AAA message one")).toBe(true)
    expect(vectorStore.upserted.some((row) => row.text === "BBB message one")).toBe(false)
    expect(vectorStore.upserted.some((row) => row.text === "CCC message one")).toBe(false)
  })

  // #given limitSessions=0
  // #when build is called
  // #then it throws a controlled error
  test("limitSessions=0 throws a controlled error", async () => {
    const sourceDbPath = createFixtureDb("limit-zero")
    await expect(
      buildOpenCodeSessionVectorIndex({
        sourceDbPath,
        vectorDbPath: tempPath("limit-zero-vector", ""),
        manifestPath: tempPath("limit-zero-manifest", ".json"),
        embeddingClient: new ConstantEmbeddingClient(),
        embedding: {
          provider: "fake",
          endpoint: "fake://embedding",
          model: "fake-model",
          dimensions: 3,
        },
        limitSessions: 0,
      }),
    ).rejects.toThrow("limitSessions must be a positive integer")
  })

  // #given limitSessions=-1
  // #when build is called
  // #then it throws a controlled error
  test("limitSessions negative throws a controlled error", async () => {
    const sourceDbPath = createFixtureDb("limit-neg")
    await expect(
      buildOpenCodeSessionVectorIndex({
        sourceDbPath,
        vectorDbPath: tempPath("limit-neg-vector", ""),
        manifestPath: tempPath("limit-neg-manifest", ".json"),
        embeddingClient: new ConstantEmbeddingClient(),
        embedding: {
          provider: "fake",
          endpoint: "fake://embedding",
          model: "fake-model",
          dimensions: 3,
        },
        limitSessions: -1,
      }),
    ).rejects.toThrow("limitSessions must be a positive integer")
  })
})
