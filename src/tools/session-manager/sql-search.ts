import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { getDataDir } from "../../shared/data-path"
import type { SearchResult } from "./types"
import { extractCoreTextFragments, extractRole, parseSessionData } from "./session-row"

export interface SQLSearchOptions {
  query: string
  sessionID?: string
  caseSensitive?: boolean
  limit?: number
}

interface SearchRow {
  session_id: string
  session_title: string
  message_id: string
  mtime: number
  data: string
  matched_part_data?: string | null
}

export function getDBPath(): string {
  const dataDir = join(getDataDir(), "opencode")
  const configured = process.env.OPENCODE_DB?.trim()
  if (configured) {
    if (configured === ":memory:" || isAbsolute(configured)) return configured
    return join(dataDir, configured)
  }

  const channel = process.env.OPENCODE_CHANNEL?.trim()
  const disableChannelDB = process.env.OPENCODE_DISABLE_CHANNEL_DB
  if (channel && !disableChannelDB && !["latest", "beta", "prod"].includes(channel)) {
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return join(dataDir, `opencode-${safe}.db`)
  }

  return join(dataDir, "opencode.db")
}

function openDB(): Database | null {
  const dbPath = getDBPath()
  if (!existsSync(dbPath)) {
    return null
  }
  try {
    const db = new Database(dbPath, { readonly: true })
    db.run("PRAGMA query_only = ON")
    return db
  } catch {
    return null
  }
}

function termsFor(query: string): string[] {
  const tokens = query.match(/[\w\u4e00-\u9fff-]+/gu)
  if (!tokens || tokens.length === 0) return []
  return Array.from(new Set(tokens.map((t) => t.trim()).filter(Boolean)))
}

function snippetAround(text: string, query: string, contextSize = 80): string {
  let idx = -1
  if (query.length > 0) {
    idx = text.toLowerCase().indexOf(query.toLowerCase())
  }
  if (idx < 0) {
    idx = 0
  }
  const start = Math.max(0, idx - contextSize)
  const end = Math.min(text.length, idx + query.length + contextSize)
  let result = text.slice(start, end)
  if (start > 0) result = "..." + result
  if (end < text.length) result = result + "..."
  return result
}

function extractPartText(data: string): { text: string; raw: string } {
  // Detect malformed JSON — only actual parse failures trigger raw-text fallback.
  // Valid empty objects like {} must NOT be treated as malformed.
  try {
    JSON.parse(data || "{}")
  } catch {
    return { text: data || "", raw: data || "" }
  }
  // Valid JSON — use shared helpers for field extraction
  const parsed = parseSessionData(data)
  const fragments = extractCoreTextFragments(parsed)
  const raw = JSON.stringify(parsed)
  return { text: fragments.map((f) => f.text).join(" | "), raw }
}

function countMatches(text: string, term: string): number {
  if (!term) return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(term, pos)) !== -1) {
    count++
    pos += term.length
  }
  return count
}

function scoreFor(matchTypes: string[], matchCount: number): number {
  const base = matchTypes.includes("text") ? 0.7 : 0.55
  return Math.min(1.0, base + Math.min(matchCount, 6) * 0.05)
}

function executeSQLSearch(
  db: Database,
  terms: string[],
  sessionID: string | undefined,
  caseSensitive: boolean,
  limit: number,
): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  function searchColumn(table: "part" | "message", term: string): void {
    if (results.length >= limit) return

    const whereCol = table === "message" ? "m.data" : "part.data"
    const joinClause = table === "part" ? "JOIN part ON part.message_id = m.id" : ""
    const select = table === "part"
      ? "SELECT s.id as session_id, s.title as session_title, m.id as message_id, m.time_created as mtime, m.data as data, part.data as matched_part_data"
      : "SELECT s.id as session_id, s.title as session_title, m.id as message_id, m.time_created as mtime, m.data as data, NULL as matched_part_data"

    const termParam = caseSensitive ? term : term.toLowerCase()
    const instrExpr = caseSensitive
      ? `instr(${whereCol}, ?) > 0`
      : `instr(lower(${whereCol}), ?) > 0`

    let sql = `${select} FROM message m
     JOIN session s ON m.session_id = s.id
     ${joinClause}
     WHERE ${instrExpr}`

    const params: string[] = [termParam]

    if (sessionID) {
      sql += " AND m.session_id = ?"
      params.push(sessionID)
    }

    sql += " ORDER BY m.time_created DESC LIMIT ?"
    params.push(String(limit * 3))

    const rows = db.query(sql).all(...params) as SearchRow[]

    for (const row of rows) {
      if (results.length >= limit) break

      const key = `${row.session_id}:${row.message_id}`
      if (seen.has(key)) continue

      const parsed = parseSessionData(row.data)
      const role = extractRole(row.data)

      const partRows = table === "part" && row.matched_part_data
        ? [{ data: row.matched_part_data }]
        : db
          .query("SELECT data FROM part WHERE message_id = ? ORDER BY id LIMIT 5")
          .all(row.message_id) as { data: string }[]

      const extractedParts = partRows.map((pr) => extractPartText(pr.data))
      const combined = extractedParts.map((part) => part.text).filter(Boolean).join(" | ")
      const rawCombined = extractedParts.map((part) => part.raw).filter(Boolean).join(" | ")
      const searchCombined = caseSensitive ? combined : combined.toLowerCase()
      const searchRawCombined = caseSensitive ? rawCombined : rawCombined.toLowerCase()
      const searchTerm = caseSensitive ? term : term.toLowerCase()
      const matchTypes: string[] = []

      let matchCount = countMatches(searchCombined, searchTerm)
      if (matchCount > 0) {
        matchTypes.push("text")
      }

      if (matchCount === 0) {
        matchCount = countMatches(searchRawCombined, searchTerm)
        if (matchCount > 0) {
          matchTypes.push("data")
        }
      }

      if (matchCount === 0) {
        const dataStr = caseSensitive ? JSON.stringify(parsed) : JSON.stringify(parsed).toLowerCase()
        matchCount = countMatches(dataStr, searchTerm)
        if (matchCount > 0) {
          matchTypes.push("data")
        }
      }

      if (matchCount === 0) {
        const dataRaw = caseSensitive ? (row.data || "") : (row.data || "").toLowerCase()
        matchCount = countMatches(dataRaw, searchTerm)
        if (matchCount > 0 && !matchTypes.includes("data")) {
          matchTypes.push("data")
        }
      }

      if (matchCount === 0) continue

      const excerptSource = combined && matchTypes.includes("text") ? combined : rawCombined
      const excerpt = excerptSource
        ? snippetAround(excerptSource, term)
        : snippetAround(JSON.stringify(parsed), term, 120)

      seen.add(key)
      results.push({
        session_id: row.session_id || "",
        message_id: row.message_id || "",
        role,
        excerpt,
        match_count: matchCount,
        timestamp: typeof row.mtime === "number" ? row.mtime : undefined,
        match_type: matchTypes.length > 0 ? matchTypes : ["text"],
        source: "sql",
        title: row.session_title || "",
        score: scoreFor(matchTypes, matchCount),
      })
    }
  }

  for (const term of terms.slice(0, 6)) {
    searchColumn("part", term)
    if (results.length >= limit) break
    searchColumn("message", term)
    if (results.length >= limit) break
  }

  results.sort((a, b) => {
    const scoreDiff = b.score - a.score
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff
    return (b.timestamp ?? 0) - (a.timestamp ?? 0)
  })

  return results.slice(0, limit)
}

export function searchSessionsSQL(
  db: Database,
  options: SQLSearchOptions,
): SearchResult[] {
  const query = options.query.trim()
  if (!query) return []

  const searchTerms = termsFor(query)
  if (searchTerms.length === 0) return []

  const limit = options.limit && options.limit > 0 ? options.limit : 20

  return executeSQLSearch(
    db,
    searchTerms,
    options.sessionID,
    options.caseSensitive ?? false,
    limit,
  )
}

export function searchSessions(
  options: SQLSearchOptions,
): SearchResult[] {
  const db = openDB()
  if (!db) return []
  try {
    return searchSessionsSQL(db, options)
  } finally {
    db.close()
  }
}
