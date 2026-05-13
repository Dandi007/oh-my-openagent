import * as lancedb from "@lancedb/lancedb"
import { QueryRequestSchema } from "./schemas"
import type {
  QueryRequest,
  QueryResponse,
  QueryResult,
  RuntimeDiagnostics,
  SourceNamespace,
} from "./types"

export interface LanceDbChunkInput {
  source: SourceNamespace
  chunk_id: string
  text: string
  metadata: Record<string, unknown>
  schema_version: string
  chunk_hash: string
  embedding: number[]
  updated_at: string
}

export interface LanceDbQueryContext {
  manifestValidated?: boolean
}

export interface LanceDbVectorStore {
  upsertChunks(chunks: LanceDbChunkInput[]): Promise<void>
  deleteMissing(source: SourceNamespace, currentChunkIds: string[]): Promise<void>
  query(
    request: QueryRequest,
    embedding: number[],
    context?: LanceDbQueryContext,
  ): Promise<QueryResponse>
}

export interface CreateLanceDbVectorStoreOptions {
  dbPath: string
  tableName: string
}

type LanceDbStoredRow = LanceDbChunkInput & Record<string, unknown>

interface LanceDbSearchRow {
  source?: unknown
  chunk_id?: unknown
  text?: unknown
  metadata?: unknown
  _distance?: unknown
}

interface LanceDbSearchBuilderLike {
  vectorColumn?: (columnName: string) => LanceDbSearchBuilderLike
  where: (filter: string) => LanceDbSearchBuilderLike
  limit: (limit: number) => LanceDbSearchBuilderLike
  toArray: () => Promise<unknown[]>
}

interface LanceDbTableLike {
  add(rows: LanceDbStoredRow[]): Promise<unknown>
  delete(filter: string): Promise<unknown>
  search(vector: number[]): LanceDbSearchBuilderLike
}

const VECTOR_INDEX_MISSING_REASON = "vector_index_missing"

function diagnostics(
  semanticAvailable: boolean,
  context: LanceDbQueryContext | undefined,
  reason?: string,
): RuntimeDiagnostics {
  return {
    backend: "lancedb",
    manifest_validated: context?.manifestValidated ?? false,
    semantic_available: semanticAvailable,
    ...(reason ? { reason } : {}),
  }
}

function emptyResponse(
  context: LanceDbQueryContext | undefined,
  reason: string,
): QueryResponse {
  return {
    results: [],
    diagnostics: diagnostics(false, context, reason),
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sourceFilter(source: SourceNamespace): string {
  return `source = ${quoteSqlString(source)}`
}

function chunkIdList(chunkIds: string[]): string {
  return chunkIds.map(quoteSqlString).join(", ")
}

function deleteExistingFilter(source: SourceNamespace, chunkIds: string[]): string {
  if (chunkIds.length === 0) {
    return ""
  }
  return `${sourceFilter(source)} AND chunk_id IN (${chunkIdList(chunkIds)})`
}

function chunksBySource(chunks: LanceDbChunkInput[]): Map<SourceNamespace, string[]> {
  const grouped = new Map<SourceNamespace, string[]>()
  for (const chunk of chunks) {
    const existing = grouped.get(chunk.source) ?? []
    existing.push(chunk.chunk_id)
    grouped.set(chunk.source, existing)
  }
  return grouped
}

function deleteMissingFilter(source: SourceNamespace, currentChunkIds: string[]): string {
  if (currentChunkIds.length === 0) {
    return sourceFilter(source)
  }
  return `${sourceFilter(source)} AND chunk_id NOT IN (${chunkIdList(currentChunkIds)})`
}

function toStoredRows(chunks: LanceDbChunkInput[]): LanceDbStoredRow[] {
  return chunks.map((chunk) => ({
    source: chunk.source,
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    metadata: chunk.metadata,
    schema_version: chunk.schema_version,
    chunk_hash: chunk.chunk_hash,
    embedding: chunk.embedding,
    updated_at: chunk.updated_at,
  }))
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return normalizeMetadata(parsed)
    } catch {
      return {}
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  }
  return {}
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "")
}

function normalizeScore(distance: unknown): number {
  if (typeof distance !== "number" || !Number.isFinite(distance)) {
    return 0
  }
  return 1 / (1 + Math.max(distance, 0))
}

function normalizeRows(rows: unknown[]): QueryResult[] {
  return (rows as LanceDbSearchRow[]).map((row) => ({
    source: normalizeString(row.source),
    chunk_id: normalizeString(row.chunk_id),
    text: normalizeText(row.text),
    score: normalizeScore(row._distance),
    metadata: normalizeMetadata(row.metadata),
  }))
}

async function openTable(
  options: CreateLanceDbVectorStoreOptions,
): Promise<LanceDbTableLike | undefined> {
  try {
    const db = await lancedb.connect(options.dbPath)
    const table = await db.openTable(options.tableName)
    return table as unknown as LanceDbTableLike
  } catch {
    return undefined
  }
}

async function createTable(
  options: CreateLanceDbVectorStoreOptions,
  rows: LanceDbStoredRow[],
): Promise<LanceDbTableLike> {
  const db = await lancedb.connect(options.dbPath)
  const table = await db.createTable(options.tableName, rows)
  return table as unknown as LanceDbTableLike
}

function createSearchBuilder(
  table: LanceDbTableLike,
  embedding: number[],
  source: SourceNamespace,
  topK: number,
): LanceDbSearchBuilderLike {
  const initial = table.search(embedding)
  const withVectorColumn = initial.vectorColumn
    ? initial.vectorColumn("embedding")
    : initial
  return withVectorColumn.where(sourceFilter(source)).limit(topK)
}

export function createLanceDbVectorStore(
  options: CreateLanceDbVectorStoreOptions,
): LanceDbVectorStore {
  return {
    async upsertChunks(chunks: LanceDbChunkInput[]): Promise<void> {
      if (chunks.length === 0) {
        return
      }
      const rows = toStoredRows(chunks)
      const existing = await openTable(options)
      if (!existing) {
        await createTable(options, rows)
        return
      }

      const table = existing
      for (const [source, chunkIds] of chunksBySource(chunks)) {
        await table.delete(deleteExistingFilter(source, chunkIds))
      }
      await table.add(rows)
    },

    async deleteMissing(
      source: SourceNamespace,
      currentChunkIds: string[],
    ): Promise<void> {
      const table = await openTable(options)
      if (!table) {
        return
      }
      await table.delete(deleteMissingFilter(source, currentChunkIds))
    },

    async query(
      request: QueryRequest,
      embedding: number[],
      context?: LanceDbQueryContext,
    ): Promise<QueryResponse> {
      const parsed = QueryRequestSchema.safeParse(request)
      if (!parsed.success) {
        return emptyResponse(context, "invalid_query_request")
      }

      const table = await openTable(options)
      if (!table) {
        return emptyResponse(context, VECTOR_INDEX_MISSING_REASON)
      }

      try {
        const builder = createSearchBuilder(
          table,
          embedding,
          parsed.data.source,
          parsed.data.top_k,
        )
        const rows = await builder.toArray()
        return {
          results: normalizeRows(rows),
          diagnostics: diagnostics(true, context),
        }
      } catch {
        return emptyResponse(context, VECTOR_INDEX_MISSING_REASON)
      }
    },
  }
}
