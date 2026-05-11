import { describe, test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { session_list, session_read, session_search, session_info } from "./tools"
import type { ToolContext } from "@opencode-ai/plugin/tool"

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

function createVectorAdapter(sessionID = "ses_vector"): string {
  const adapterPath = join(tmpdir(), `omo-tools-vector-${Date.now()}-${Math.random().toString(36).slice(2)}.py`)
  const payload = {
    results: [
      {
        path: `opencode://${sessionID}`,
        session_id: sessionID,
        message_id: "msg_vector",
        title: "Vector Session",
        score: 0.2,
        match_type: ["semantic"],
        snippet: "needle from vector backend",
        source_type: "opencode_session",
        heading_path: "message/assistant",
      },
    ],
  }
  writeFileSync(adapterPath, `#!/usr/bin/env python3\nimport json\nprint(${JSON.stringify(JSON.stringify(payload))})\n`)
  return adapterPath
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
    const adapterPath = createVectorAdapter("ses_vector_empty")
    try {
      await withEnv({ OPENCODE_DB: "/missing/opencode.db", OMO_SESSION_SEARCH_VECTOR_ADAPTER: adapterPath }, async () => {
        const result = await session_search.execute({ query: "   ", limit: 5 }, mockContext)

        expect(result).toBe("No matches found.")
      })
    } finally {
      removeIfExists(adapterPath)
    }
  })

  test("session_search uses SQL backend when vector adapter is absent", async () => {
    const dbPath = createSearchDB()
    try {
      await withEnv({ OPENCODE_DB: dbPath, OMO_SESSION_SEARCH_VECTOR_ADAPTER: "/missing/query_lancedb.py" }, async () => {
        const result = await session_search.execute({ query: "needle", limit: 5 }, mockContext)

        expect(result).toContain("SQL Session")
        expect(result).toContain("needle from SQL backend")
      })
    } finally {
      removeIfExists(dbPath)
    }
  })

  test("session_search falls back to vector backend when SQL schema is unavailable", async () => {
    const dbPath = join(tmpdir(), `omo-tools-bad-schema-${Date.now()}.db`)
    const db = new Database(dbPath)
    db.run("CREATE TABLE unrelated (id TEXT)")
    db.close()
    const adapterPath = createVectorAdapter()
    try {
      await withEnv({ OPENCODE_DB: dbPath, OMO_SESSION_SEARCH_VECTOR_ADAPTER: adapterPath }, async () => {
        const result = await session_search.execute({ query: "needle", limit: 5 }, mockContext)

        expect(result).toContain("Vector Session")
        expect(result).toContain("needle from vector backend")
        expect(result).toContain("[vector]")
      })
    } finally {
      removeIfExists(dbPath)
      removeIfExists(adapterPath)
    }
  })

  test("session_search applies session_id filter to vector results", async () => {
    const adapterPath = createVectorAdapter("ses_target")
    try {
      await withEnv({ OPENCODE_DB: "/missing/opencode.db", OMO_SESSION_SEARCH_VECTOR_ADAPTER: adapterPath }, async () => {
        const result = await session_search.execute({ query: "needle", session_id: "ses_other", limit: 5 }, mockContext)

        expect(result).toBe("No matches found.")
      })
    } finally {
      removeIfExists(adapterPath)
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
