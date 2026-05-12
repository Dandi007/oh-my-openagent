import { Database } from "bun:sqlite"
import * as lancedb from "@lancedb/lancedb"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { EmbeddingClient } from "../../shared/vector-runtime/embedding-client"
import {
  createLanceDbVectorStore,
  type LanceDbChunkInput,
  type LanceDbVectorStore,
} from "../../shared/vector-runtime/lancedb-adapter"
import type { ManifestContract, ManifestEmbeddingContract } from "../../shared/vector-runtime/types"

const OPENCODE_SOURCE = "opencode"
const OPENCODE_TABLE = "opencode_sessions"
const OPENCODE_SCHEMA_VERSION = "opencode-session-chunk/v1"

export interface SourceDbFingerprint {
  bytes: number
  sha256: string
}

export interface OpenCodeSessionVectorBuildStats {
  sessions: number
  messages: number
  parts: number
  chunks: number
  source_bytes: number
  source_sha256: string
}

export interface OpenCodeSessionVectorBuildResult {
  manifest: ManifestContract
  stats: OpenCodeSessionVectorBuildStats
  sourceDbBefore: SourceDbFingerprint
  sourceDbAfter: SourceDbFingerprint
  chunkIds: string[]
}

export interface OpenCodeSessionVectorBuildOptions {
  sourceDbPath: string
  vectorDbPath: string
  manifestPath: string
  embeddingClient: EmbeddingClient
  embedding: ManifestEmbeddingContract
  vectorStore?: LanceDbVectorStore
  tableName?: string
  now?: () => Date
  /** Limit the number of sessions indexed (debug/fixture only). Must be a positive integer. */
  limitSessions?: number
}

interface CountRow {
  count: number
}

interface MessageRow {
  session_id: string
  project_id: string
  directory: string
  session_title: string
  session_time_created: number
  session_time_updated: number
  message_id: string
  message_time_created: number
  message_time_updated: number
  message_data: string
}

interface PartRow extends MessageRow {
  part_id: string
  part_time_created: number
  part_time_updated: number
  part_data: string
}

interface ExtractedText {
  text: string
  fields: string[]
}

function fingerprint(path: string): SourceDbFingerprint {
  const bytes = readFileSync(path)
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function safeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9_-]/g, "_")
}

function parseObject(data: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data || "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    throw new Error(`failed to parse OpenCode session JSON: ${String(error)}`)
  }
  return {}
}

function pushStringField(
  fragments: string[],
  fields: string[],
  value: unknown,
  fieldName: string,
): void {
  if (typeof value === "string" && value.length > 0) {
    fragments.push(value)
    fields.push(fieldName)
  }
}

function extractReasoning(
  fragments: string[],
  fields: string[],
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    fragments.push(value)
    fields.push("reasoning")
    return
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    pushStringField(fragments, fields, obj.text, "reasoning.text")
  }
}

function extractSupportedText(data: string): ExtractedText {
  const parsed = parseObject(data)
  const fragments: string[] = []
  const fields: string[] = []

  pushStringField(fragments, fields, parsed.text, "text")
  pushStringField(fragments, fields, parsed.thinking, "thinking")
  extractReasoning(fragments, fields, parsed.reasoning)

  const state = parsed.state
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const stateObj = state as Record<string, unknown>
    pushStringField(fragments, fields, stateObj.title, "state.title")
    pushStringField(fragments, fields, stateObj.output, "state.output")
  }

  pushStringField(fragments, fields, parsed.prompt, "prompt")
  pushStringField(fragments, fields, parsed.description, "description")

  return {
    text: fragments.join(" | "),
    fields,
  }
}

function roleFromMessageData(data: string): string {
  const parsed = parseObject(data)
  return typeof parsed.role === "string" && parsed.role.length > 0 ? parsed.role : "unknown"
}

function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) as count FROM ${table}`).get() as CountRow | null
  return row?.count ?? 0
}

function openReadOnlySourceDb(path: string): Database {
  const db = new Database(path, { readonly: true })
  db.run("PRAGMA query_only = ON")
  return db
}

function baseMetadata(row: MessageRow, role: string): Record<string, unknown> {
  return {
    source_type: "opencode_session",
    session_id: row.session_id,
    message_id: row.message_id,
    role,
    project_id: row.project_id,
    directory: row.directory,
    session_title: row.session_title,
    session_time_created: row.session_time_created,
    session_time_updated: row.session_time_updated,
    message_time_created: row.message_time_created,
    message_time_updated: row.message_time_updated,
  }
}

function chunkFromMessage(
  row: MessageRow,
  extracted: ExtractedText,
  updatedAt: string,
): LanceDbChunkInput | undefined {
  if (extracted.text.length === 0) return undefined
  const contentHash = hashText(extracted.text)
  const role = roleFromMessageData(row.message_data)
  return {
    source: OPENCODE_SOURCE,
    chunk_id: `${OPENCODE_SOURCE}:${row.session_id}:${row.message_id}:message:${contentHash}`,
    text: extracted.text,
    metadata: {
      ...baseMetadata(row, role),
      segment: "message",
      fields: extracted.fields,
    },
    schema_version: OPENCODE_SCHEMA_VERSION,
    chunk_hash: contentHash,
    embedding: [],
    updated_at: updatedAt,
  }
}

function chunkFromPart(
  row: PartRow,
  extracted: ExtractedText,
  updatedAt: string,
): LanceDbChunkInput | undefined {
  if (extracted.text.length === 0) return undefined
  const contentHash = hashText(extracted.text)
  const role = roleFromMessageData(row.message_data)
  const segment = safeSegment(row.part_id)
  return {
    source: OPENCODE_SOURCE,
    chunk_id: `${OPENCODE_SOURCE}:${row.session_id}:${row.message_id}:${segment}:${contentHash}`,
    text: extracted.text,
    metadata: {
      ...baseMetadata(row, role),
      part_id: row.part_id,
      segment,
      fields: extracted.fields,
      part_time_created: row.part_time_created,
      part_time_updated: row.part_time_updated,
    },
    schema_version: OPENCODE_SCHEMA_VERSION,
    chunk_hash: contentHash,
    embedding: [],
    updated_at: updatedAt,
  }
}

function loadChunks(db: Database, updatedAt: string, limitSessions?: number): LanceDbChunkInput[] {
  const sessionFilter = limitSessions !== undefined
    ? `WHERE s.id IN (SELECT id FROM session ORDER BY id LIMIT ${limitSessions})`
    : ""

  const messages = db.query(`
    SELECT
      s.id as session_id,
      s.project_id as project_id,
      s.directory as directory,
      s.title as session_title,
      s.time_created as session_time_created,
      s.time_updated as session_time_updated,
      m.id as message_id,
      m.time_created as message_time_created,
      m.time_updated as message_time_updated,
      m.data as message_data
    FROM message m
    JOIN session s ON m.session_id = s.id
    ${sessionFilter}
    ORDER BY s.id, m.time_created, m.id
  `).all() as MessageRow[]

  const parts = db.query(`
    SELECT
      s.id as session_id,
      s.project_id as project_id,
      s.directory as directory,
      s.title as session_title,
      s.time_created as session_time_created,
      s.time_updated as session_time_updated,
      m.id as message_id,
      m.time_created as message_time_created,
      m.time_updated as message_time_updated,
      m.data as message_data,
      p.id as part_id,
      p.time_created as part_time_created,
      p.time_updated as part_time_updated,
      p.data as part_data
    FROM part p
    JOIN message m ON p.message_id = m.id
    JOIN session s ON p.session_id = s.id
    ${sessionFilter}
    ORDER BY s.id, m.time_created, m.id, p.time_created, p.id
  `).all() as PartRow[]

  const chunks: LanceDbChunkInput[] = []
  for (const row of messages) {
    const chunk = chunkFromMessage(row, extractSupportedText(row.message_data), updatedAt)
    if (chunk) chunks.push(chunk)
  }
  for (const row of parts) {
    const chunk = chunkFromPart(row, extractSupportedText(row.part_data), updatedAt)
    if (chunk) chunks.push(chunk)
  }
  return chunks
}

function withEmbeddings(
  chunks: LanceDbChunkInput[],
  embeddings: number[][],
  expectedDimensions: number,
): LanceDbChunkInput[] {
  if (chunks.length !== embeddings.length) {
    throw new Error(`embedding count mismatch: expected ${chunks.length}, received ${embeddings.length}`)
  }
  return chunks.map((chunk, index) => {
    const embedding = embeddings[index]
    if (!embedding || embedding.length !== expectedDimensions) {
      throw new Error(
        `embedding dimension mismatch for chunk ${chunk.chunk_id}: expected ${expectedDimensions}, received ${embedding?.length ?? 0}`,
      )
    }
    return { ...chunk, embedding }
  })
}

function createManifest(
  options: OpenCodeSessionVectorBuildOptions,
  indexedAt: string,
  tableName: string,
  stats: OpenCodeSessionVectorBuildStats,
): ManifestContract {
  return {
    contract_version: "vector-runtime/v1",
    backend: "lancedb",
    db_path: options.vectorDbPath,
    embedding: options.embedding,
    sources: {
      [OPENCODE_SOURCE]: {
        table: tableName,
        schema_version: OPENCODE_SCHEMA_VERSION,
        source_of_truth: "database",
        last_indexed_at: indexedAt,
        sessions: stats.sessions,
        messages: stats.messages,
        parts: stats.parts,
        chunks: stats.chunks,
        source_bytes: stats.source_bytes,
        source_sha256: stats.source_sha256,
      },
    },
  }
}

async function resetDefaultLanceDbTable(
  vectorDbPath: string,
  tableName: string,
): Promise<void> {
  const db = await lancedb.connect(vectorDbPath)
  const tableNames = await db.tableNames()
  if (tableNames.includes(tableName)) {
    await db.dropTable(tableName)
  }
}

export async function buildOpenCodeSessionVectorIndex(
  options: OpenCodeSessionVectorBuildOptions,
): Promise<OpenCodeSessionVectorBuildResult> {
  const tableName = options.tableName ?? OPENCODE_TABLE
  const indexedAt = (options.now ?? (() => new Date()))().toISOString()
  const expectedDimensions = options.embedding.dimensions
  if (!Number.isInteger(expectedDimensions) || expectedDimensions <= 0) {
    throw new Error(`embedding dimensions must be a positive integer, got ${expectedDimensions}`)
  }

  if (options.limitSessions !== undefined) {
    if (!Number.isInteger(options.limitSessions) || options.limitSessions <= 0) {
      throw new Error(
        `limitSessions must be a positive integer, got ${options.limitSessions}`,
      )
    }
  }

  const sourceDbBefore = fingerprint(options.sourceDbPath)
  let sessionCount = 0
  let messageCount = 0
  let partCount = 0
  let chunks: LanceDbChunkInput[] = []

  const db = openReadOnlySourceDb(options.sourceDbPath)
  try {
    sessionCount = countRows(db, "session")
    messageCount = countRows(db, "message")
    partCount = countRows(db, "part")
    chunks = loadChunks(db, indexedAt, options.limitSessions)
  } finally {
    db.close()
  }

  const sourceDbAfterRead = fingerprint(options.sourceDbPath)
  if (sourceDbAfterRead.sha256 !== sourceDbBefore.sha256 || sourceDbAfterRead.bytes !== sourceDbBefore.bytes) {
    throw new Error("source OpenCode SQLite database changed during read-only vector build")
  }

  const embeddings = await options.embeddingClient.embed(chunks.map((chunk) => chunk.text))
  const embeddedChunks = withEmbeddings(chunks, embeddings, expectedDimensions)
  const store = options.vectorStore ?? createLanceDbVectorStore({ dbPath: options.vectorDbPath, tableName })

  if (!options.vectorStore) {
    await resetDefaultLanceDbTable(options.vectorDbPath, tableName)
  }
  await store.upsertChunks(embeddedChunks)
  const chunkIds = embeddedChunks.map((chunk) => chunk.chunk_id)
  await store.deleteMissing(OPENCODE_SOURCE, chunkIds)

  const stats: OpenCodeSessionVectorBuildStats = {
    sessions: sessionCount,
    messages: messageCount,
    parts: partCount,
    chunks: embeddedChunks.length,
    source_bytes: sourceDbBefore.bytes,
    source_sha256: sourceDbBefore.sha256,
  }
  const manifest = createManifest(options, indexedAt, tableName, stats)
  await Bun.write(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const sourceDbAfter = fingerprint(options.sourceDbPath)
  if (sourceDbAfter.sha256 !== sourceDbBefore.sha256 || sourceDbAfter.bytes !== sourceDbBefore.bytes) {
    throw new Error("source OpenCode SQLite database changed during vector build")
  }

  return {
    manifest,
    stats,
    sourceDbBefore,
    sourceDbAfter,
    chunkIds,
  }
}
