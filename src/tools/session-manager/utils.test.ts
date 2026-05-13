import { describe, test, expect } from "bun:test"
import {
  formatSessionList,
  formatSessionMessages,
  formatSessionInfo,
  formatSearchResults,
  filterSessionsByDate,
  mergeAndDedupeSearchResults,
} from "./utils"
import type { SessionInfo, SessionMessage, SearchResult } from "./types"

describe("session-manager utils", () => {
  test("formatSessionList handles empty array", async () => {
    // #given
    const sessions: string[] = []

    // #when
    const result = await formatSessionList(sessions)

    // #then
    expect(result).toContain("No sessions found")
  })

  test("formatSessionMessages handles empty array", () => {
    // #given
    const messages: SessionMessage[] = []

    // #when
    const result = formatSessionMessages(messages)

    // #then
    expect(result).toContain("No messages")
  })

  test("formatSessionMessages includes message content", () => {
    // #given
    const messages: SessionMessage[] = [
      {
        id: "msg_001",
        role: "user",
        time: { created: Date.now() },
        parts: [{ id: "prt_001", type: "text", text: "Hello world" }],
      },
    ]

    // #when
    const result = formatSessionMessages(messages)

    // #then
    expect(result).toContain("user")
    expect(result).toContain("Hello world")
  })

  test("formatSessionMessages includes todos when requested", () => {
    // #given
    const messages: SessionMessage[] = [
      {
        id: "msg_001",
        role: "user",
        time: { created: Date.now() },
        parts: [{ id: "prt_001", type: "text", text: "Test" }],
      },
    ]
    const todos = [
      { id: "1", content: "Task 1", status: "completed" as const },
      { id: "2", content: "Task 2", status: "pending" as const },
    ]

    // #when
    const result = formatSessionMessages(messages, true, todos)

    // #then
    expect(result).toContain("Todos")
    expect(result).toContain("Task 1")
    expect(result).toContain("Task 2")
  })

  test("formatSessionInfo includes all metadata", () => {
    // #given
    const info: SessionInfo = {
      id: "ses_test123",
      message_count: 42,
      first_message: new Date("2025-12-20T10:00:00Z"),
      last_message: new Date("2025-12-24T15:00:00Z"),
      agents_used: ["build", "oracle"],
      has_todos: true,
      has_transcript: true,
      todos: [{ id: "1", content: "Test", status: "pending" }],
      transcript_entries: 123,
    }

    // #when
    const result = formatSessionInfo(info)

    // #then
    expect(result).toContain("ses_test123")
    expect(result).toContain("42")
    expect(result).toContain("build, oracle")
    expect(result).toContain("Duration")
  })

  test("formatSearchResults handles empty array", () => {
    // #given
    const results: SearchResult[] = []

    // #when
    const result = formatSearchResults(results)

    // #then
    expect(result).toContain("No matches")
  })

  test("formatSearchResults formats matches correctly", () => {
    // #given
    const results: SearchResult[] = [
      {
        session_id: "ses_test123",
        message_id: "msg_001",
        role: "user",
        excerpt: "...example text...",
        match_count: 3,
        timestamp: Date.now(),
        match_type: ["text"],
        source: "sql",
        title: "Test Session",
        score: 0.8,
      },
    ]

    // #when
    const result = formatSearchResults(results)

    // #then
    expect(result).toContain("Found 1 matches")
    expect(result).toContain("ses_test123")
    expect(result).toContain("msg_001")
    expect(result).toContain("example text")
    expect(result).toContain("Matches: 3")
  })

  test("filterSessionsByDate filters correctly", async () => {
    // #given
    const sessionIDs = ["ses_001", "ses_002", "ses_003"]

    // #when
    const result = await filterSessionsByDate(sessionIDs)

    // #then
    expect(Array.isArray(result)).toBe(true)
  })

  test("mergeAndDedupeSearchResults deduplicates SQL and vector hits by message", () => {
    // #given
    const sqlResult: SearchResult = {
      session_id: "ses_test123",
      message_id: "msg_001",
      role: "user",
      excerpt: "exact match",
      match_count: 2,
      match_type: ["text"],
      source: "sql",
      title: "Test Session",
      score: 0.9,
    }
    const duplicateVector: SearchResult = {
      ...sqlResult,
      excerpt: "semantic duplicate",
      source: "vector",
      score: 0.95,
    }

    // #when
    const results = mergeAndDedupeSearchResults([sqlResult], [duplicateVector], 10)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0].source).toBe("sql")
  })

  test("mergeAndDedupeSearchResults sorts by normalized score and applies limit", () => {
    // #given
    const lowScoreSql: SearchResult = {
      session_id: "ses_a",
      message_id: "msg_a",
      role: "user",
      excerpt: "low",
      match_count: 1,
      match_type: ["data"],
      source: "sql",
      title: "A",
      score: 0.55,
    }
    const highScoreVector: SearchResult = {
      session_id: "ses_a",
      message_id: "msg_b",
      role: "assistant",
      excerpt: "high",
      match_count: 1,
      match_type: ["semantic"],
      source: "vector",
      title: "A",
      score: 0.8,
    }

    // #when
    const results = mergeAndDedupeSearchResults([lowScoreSql], [highScoreVector], 1)

    // #then
    expect(results).toHaveLength(1)
    expect(results[0].message_id).toBe("msg_b")
  })

  // ── Characterization: hybrid merge semantics ─────────────────────

  test("CHAR: SQL wins over vector for same session_id:message_id regardless of score", () => {
    // #given — SQL has lower score but same key
    const sqlResult: SearchResult = {
      session_id: "ses_x",
      message_id: "msg_x",
      role: "user",
      excerpt: "sql match",
      match_count: 2,
      match_type: ["text"],
      source: "sql",
      title: "Test",
      score: 0.3,
    }
    const vectorResult: SearchResult = {
      session_id: "ses_x",
      message_id: "msg_x",
      role: "user",
      excerpt: "vector match",
      match_count: 1,
      match_type: ["semantic"],
      source: "vector",
      title: "Test",
      score: 0.99,
    }

    // #when
    const results = mergeAndDedupeSearchResults([sqlResult], [vectorResult], 10)

    // #then — SQL wins dedupe even with lower score
    expect(results).toHaveLength(1)
    expect(results[0].source).toBe("sql")
    expect(results[0].excerpt).toBe("sql match")
  })

  test("CHAR: merge preserves distinct messages from both sources", () => {
    // #given
    const sqlOnly: SearchResult = {
      session_id: "ses_a",
      message_id: "msg_sql_only",
      role: "user",
      excerpt: "sql only",
      match_count: 1,
      match_type: ["text"],
      source: "sql",
      title: "A",
      score: 0.7,
    }
    const vectorOnly: SearchResult = {
      session_id: "ses_b",
      message_id: "msg_vec_only",
      role: "assistant",
      excerpt: "vector only",
      match_count: 1,
      match_type: ["semantic"],
      source: "vector",
      title: "B",
      score: 0.6,
    }

    // #when
    const results = mergeAndDedupeSearchResults([sqlOnly], [vectorOnly], 10)

    // #then — both distinct messages preserved
    expect(results).toHaveLength(2)
    const sources = results.map((r) => r.source).sort()
    expect(sources).toEqual(["sql", "vector"])
  })

  test("CHAR: merge truncates to limit after dedupe and sort", () => {
    // #given — 4 results, limit 2
    const r1: SearchResult = {
      session_id: "ses_1", message_id: "msg_1", role: "user",
      excerpt: "r1", match_count: 1, match_type: ["text"],
      source: "sql", title: "S1", score: 0.9,
    }
    const r2: SearchResult = {
      session_id: "ses_2", message_id: "msg_2", role: "user",
      excerpt: "r2", match_count: 1, match_type: ["text"],
      source: "sql", title: "S2", score: 0.8,
    }
    const r3: SearchResult = {
      session_id: "ses_3", message_id: "msg_3", role: "assistant",
      excerpt: "r3", match_count: 1, match_type: ["semantic"],
      source: "vector", title: "S3", score: 0.7,
    }
    const r4: SearchResult = {
      session_id: "ses_4", message_id: "msg_4", role: "assistant",
      excerpt: "r4", match_count: 1, match_type: ["semantic"],
      source: "vector", title: "S4", score: 0.6,
    }

    // #when
    const results = mergeAndDedupeSearchResults([r1, r2], [r3, r4], 2)

    // #then — only top 2 by score
    expect(results).toHaveLength(2)
    expect(results[0].message_id).toBe("msg_1")
    expect(results[1].message_id).toBe("msg_2")
  })

  test("CHAR: formatSearchResults tags vector-origin results with [vector]", () => {
    // #given
    const sqlResult: SearchResult = {
      session_id: "ses_s", message_id: "msg_s", role: "user",
      excerpt: "sql excerpt", match_count: 1, match_type: ["text"],
      source: "sql", title: "SQL", score: 0.9, timestamp: Date.now(),
    }
    const vectorResult: SearchResult = {
      session_id: "ses_v", message_id: "msg_v", role: "assistant",
      excerpt: "vector excerpt", match_count: 1, match_type: ["semantic"],
      source: "vector", title: "Vector", score: 0.8, timestamp: Date.now(),
    }

    // #when
    const result = formatSearchResults([sqlResult, vectorResult])

    // #then
    expect(result).toContain("Found 2 matches")
    // SQL result must NOT have [vector]
    const sqlLine = result.split("\n").find((l) => l.includes("msg_s"))
    expect(sqlLine).toBeDefined()
    expect(sqlLine!).not.toContain("[vector]")
    // Vector result MUST have [vector]
    const vecLine = result.split("\n").find((l) => l.includes("msg_v"))
    expect(vecLine).toBeDefined()
    expect(vecLine!).toContain("[vector]")
  })
})
