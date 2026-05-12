import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, unlinkSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { session_list, session_read, session_search, session_info } from "./tools"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { createLanceDbVectorStore } from "../../shared/vector-runtime/lancedb-adapter"

// Snapshot the real fetch at module-load time so the embedding server
// works even when other test files leave globalThis.fetch mocked.
const _realFetch = globalThis.fetch

const FIXED_VECTOR = [0.1, 0.2, 0.3, 0.4]

let embeddingServer: ReturnType<typeof Bun.serve> | null = null
let embeddingEndpoint = ""

beforeAll(() => {
  embeddingServer = Bun.serve({
    port: 0,
    fetch(_req) {
      return new Response(
        JSON.stringify({
          data: [{ embedding: FIXED_VECTOR, index: 0 }],
          model: "test-model",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { headers: { "Content-Type": "application/json" } },
      )
    },
  })
  embeddingEndpoint = `http://localhost:${embeddingServer.port}/v1/embeddings`
})

afterAll(() => {
  if (embeddingServer) {
    embeddingServer.stop()
  }
})

const mockContext: ToolContext = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "test-agent",
  abort: new AbortController().signal,
}

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key]
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return run().finally(() => {
    for (const key of Object.keys(values)) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

function createSearchDB(): string {
  const dbPath = join(tmpdir(), `omo-tools-search-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(dbPath)
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL)")
  db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL)")
  db.run("INSERT INTO session (id, title) VALUES (?, ?)", ["ses_sql", "SQL Session"])
  db.run("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)", ["msg_sql", "ses_sql", Date.now(), JSON.stringify({ role: "user" })])
  db.run("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)", ["prt_sql", "msg_sql", "ses_sql", JSON.stringify({ type: "text", text: "needle from SQL backend" })])
  db.close()
  return dbPath
}

interface VectorBackendFixture {
  env: Record<string, string>
  cleanup: () => void
}

async function setupVectorBackend(sessionID: string): Promise<VectorBackendFixture> {
  const tmpDir = join(tmpdir(), `omo-tools-vector-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })

  const dbPath = join(tmpDir, "lancedb")
  const manifestPath = join(tmpDir, "manifest.json")

  const manifest = {
    contract_version: "vector-runtime/v1",
    backend: "lancedb",
    db_path: dbPath,
    embedding: {
      provider: "http",
      endpoint: embeddingEndpoint,
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

  const store = createLanceDbVectorStore({ dbPath, tableName: "opencode_sessions" })
  await store.upsertChunks([
    {
      source: "opencode",
      chunk_id: `opencode:${sessionID}:msg_vector:prt_vector:hash_vector`,
      text: "needle from vector backend",
      metadata: {
        session_id: sessionID,
        message_id: "msg_vector",
        role: "assistant",
        session_title: "Vector Session",
        session_time_created: Date.now(),
        message_time_created: Date.now(),
      },
      schema_version: "opencode-session-chunk/v1",
      chunk_hash: "hash_vector",
      embedding: FIXED_VECTOR,
      updated_at: new Date().toISOString(),
    },
  ])

  return {
    env: {
      AGENT_VECTOR_DB_BACKEND: "lancedb",
      AGENT_VECTOR_DB_PATH: dbPath,
      AGENT_VECTOR_MANIFEST: manifestPath,
      AGENT_EMBEDDING_ENDPOINT: embeddingEndpoint,
      AGENT_EMBEDDING_MODEL: "test-model",
      AGENT_EMBEDDING_DIMENSIONS: "4",
    },
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path)
}

describe("session-manager tools", () => {
  test("session_list executes without error", async () => {
    const result = await session_list.execute({}, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_list respects limit parameter", async () => {
    const result = await session_list.execute({ limit: 5 }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_list filters by date range", async () => {
    const result = await session_list.execute({
      from_date: "2025-12-01T00:00:00Z",
      to_date: "2025-12-31T23:59:59Z",
    }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_list filters by project_path", async () => {
    // #given
    const projectPath = "/Users/yeongyu/local-workspaces/oh-my-opencode"

    // #when
    const result = await session_list.execute({ project_path: projectPath }, mockContext)

    // #then
    expect(typeof result).toBe("string")
  })

  test("session_list uses process.cwd() as default project_path", async () => {
    // #given - no project_path provided

    // #when
    const result = await session_list.execute({}, mockContext)

    // #then - should not throw and return string (uses process.cwd() internally)
    expect(typeof result).toBe("string")
  })

  test("session_read handles non-existent session", async () => {
    const result = await session_read.execute({ session_id: "ses_nonexistent" }, mockContext)
    
    expect(result).toContain("not found")
  })

  test("session_read executes with valid parameters", async () => {
    const result = await session_read.execute({
      session_id: "ses_test123",
      include_todos: true,
      include_transcript: true,
    }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_read respects limit parameter", async () => {
    const result = await session_read.execute({
      session_id: "ses_test123",
      limit: 10,
    }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_search executes without error", async () => {
    const result = await session_search.execute({ query: "test" }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_search filters by session_id", async () => {
    const result = await session_search.execute({
      query: "test",
      session_id: "ses_test123",
    }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_search respects case_sensitive parameter", async () => {
    const result = await session_search.execute({
      query: "TEST",
      case_sensitive: true,
    }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_search respects limit parameter", async () => {
    const result = await session_search.execute({
      query: "test",
      limit: 5,
    }, mockContext)
    
    expect(typeof result).toBe("string")
  })

  test("session_search returns no matches for empty query before calling adapters", async () => {
    const result = await session_search.execute({ query: "   ", limit: 5 }, mockContext)

    expect(result).toBe("No matches found.")
  })

  test("session_search uses SQL backend when vector adapter is absent", async () => {
    const dbPath = createSearchDB()
    try {
      await withEnv({ OPENCODE_DB: dbPath }, async () => {
        const result = await session_search.execute({ query: "needle", limit: 5 }, mockContext)

        expect(result).toContain("SQL Session")
        expect(result).toContain("needle from SQL backend")
      })
    } finally {
      removeIfExists(dbPath)
    }
  })

  test("session_search falls back to vector backend when SQL schema is unavailable", async () => {
    // Restore real fetch in case another test file left it mocked
    if (typeof _realFetch === "function") globalThis.fetch = _realFetch
    const dbPath = join(tmpdir(), `omo-tools-bad-schema-${Date.now()}.db`)
    const db = new Database(dbPath)
    db.run("CREATE TABLE unrelated (id TEXT)")
    db.close()
    const fixture = await setupVectorBackend("ses_vector")
    try {
      await withEnv({ ...fixture.env, OPENCODE_DB: dbPath }, async () => {
        const result = await session_search.execute({ query: "needle", limit: 5 }, mockContext)

        expect(result).toContain("Vector Session")
        expect(result).toContain("needle from vector backend")
        expect(result).toContain("[vector]")
      })
    } finally {
      removeIfExists(dbPath)
      fixture.cleanup()
    }
  })

  test("session_search applies session_id filter to vector results", async () => {
    const fixture = await setupVectorBackend("ses_target")
    try {
      await withEnv({ ...fixture.env, OPENCODE_DB: "/missing/opencode.db" }, async () => {
        const result = await session_search.execute({ query: "needle", session_id: "ses_other", limit: 5 }, mockContext)

        expect(result).toBe("No matches found.")
      })
    } finally {
      fixture.cleanup()
    }
  })

  test("session_info handles non-existent session", async () => {
    const result = await session_info.execute({ session_id: "ses_nonexistent" }, mockContext)
    
    expect(result).toContain("not found")
  })

  test("session_info executes with valid session", async () => {
    const result = await session_info.execute({ session_id: "ses_test123" }, mockContext)
    
    expect(typeof result).toBe("string")
  })
})
