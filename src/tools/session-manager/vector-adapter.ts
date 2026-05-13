import { existsSync } from "node:fs"
import type { SearchResult } from "./types"
import { resolveVectorConfig } from "../../shared/vector-runtime/paths"
import {
  loadManifest,
  validateManifestForSource,
} from "../../shared/vector-runtime/manifest"
import {
  createHttpEmbeddingClient,
  type EmbeddingClient,
} from "../../shared/vector-runtime/embedding-client"
import {
  createLanceDbVectorStore,
  type LanceDbVectorStore,
} from "../../shared/vector-runtime/lancedb-adapter"
import type { QueryResult } from "../../shared/vector-runtime/types"

const OPENCODE_SOURCE = "opencode"

/** Test-injectable dependencies for queryVectorAdapter. */
export interface VectorAdapterDeps {
  env?: Record<string, string | undefined>
  embeddingClient?: EmbeddingClient
  vectorStore?: LanceDbVectorStore
}

interface VectorAdapterOptions {
  topK?: number
  sessionId?: string
  timeoutMs?: number
  _deps?: VectorAdapterDeps
}

function deterministicSuffix(input: string): string {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  const abs = Math.abs(hash)
  return abs.toString(36).slice(0, 8)
}

function queryResultToSearchResult(item: QueryResult): SearchResult {
  const meta = item.metadata
  const sessionID = typeof meta.session_id === "string" ? meta.session_id : ""
  const messageID = typeof meta.message_id === "string" ? meta.message_id : ""
  const role = typeof meta.role === "string" ? meta.role : "unknown"
  const title = typeof meta.session_title === "string" ? meta.session_title : ""
  const messageTimeCreated =
    typeof meta.message_time_created === "number" ? meta.message_time_created : undefined

  const stableSeed = [sessionID, item.chunk_id, item.text.slice(0, 50), role].join(":")
  const suffix = deterministicSuffix(stableSeed)
  const resolvedMessageID = messageID || `${sessionID}_vec_${suffix}`

  return {
    session_id: sessionID,
    message_id: resolvedMessageID,
    role,
    excerpt: item.text,
    match_count: 1,
    timestamp: messageTimeCreated,
    match_type: ["semantic"],
    source: "vector",
    title,
    score: item.score,
  }
}

/**
 * Resolve the runtime context for vector query: either from test-injected
 * dependencies or from environment-based configuration.
 *
 * Returns `null` when vector is unavailable (missing config, invalid
 * manifest, wrong backend, etc.) — the caller returns `[]` gracefully.
 */
async function resolveVectorContext(
  options: VectorAdapterOptions,
): Promise<{ embeddingClient: EmbeddingClient; vectorStore: LanceDbVectorStore } | null> {
  const deps = options._deps

  // ── Test injection path: both clients provided → use directly ─────
  if (deps?.embeddingClient && deps?.vectorStore) {
    return {
      embeddingClient: deps.embeddingClient,
      vectorStore: deps.vectorStore,
    }
  }

  // ── Env-based resolution ──────────────────────────────────────────
  const envInput = buildEnvInput(deps?.env, options.timeoutMs)

  // Resolve vector paths and config via shared resolver.
  // Precedence: explicit overrides (none here) > env vars > default cache paths.
  const config = resolveVectorConfig({}, envInput)

  const rawBackend = envInput?.AGENT_VECTOR_DB_BACKEND?.trim()
  const effectiveBackend = config.backend === "noop" && !rawBackend ? "lancedb" : config.backend

  if (effectiveBackend !== "lancedb") return null
  if (!config.embedding.endpoint) return null

  const dbPath = config.indexPath
  if (!existsSync(dbPath)) return null

  const manifestPath = config.manifestPath
  if (!manifestPath) return null

  // ── Load and validate manifest ────────────────────────────────────
  const manifestResult = await loadManifest(manifestPath)
  if (!manifestResult.ok) return null

  const validation = validateManifestForSource(
    manifestResult.manifest,
    OPENCODE_SOURCE,
    { backend: effectiveBackend, dbPath, manifestPath, embedding: config.embedding },
  )
  if (!validation.valid) return null

  const sourceEntry = manifestResult.manifest.sources[OPENCODE_SOURCE]
  if (!sourceEntry) return null

  // ── Create runtime clients ────────────────────────────────────────
  const embeddingClient = createHttpEmbeddingClient({
    backend: effectiveBackend,
    embedding: config.embedding,
    timeoutMs: config.timeoutMs,
  })
  const vectorStore = createLanceDbVectorStore({
    dbPath,
    tableName: sourceEntry.table,
  })

  return { embeddingClient, vectorStore }
}

function buildEnvInput(
  baseEnv: Record<string, string | undefined> | undefined,
  timeoutMs: number | undefined,
): Record<string, string | undefined> | undefined {
  if (timeoutMs === undefined) return baseEnv
  const merged: Record<string, string | undefined> = {
    ...(baseEnv ?? (typeof process !== "undefined" ? process.env as Record<string, string | undefined> : {})),
  }
  merged["AGENT_VECTOR_TIMEOUT_MS"] = String(timeoutMs)
  return merged
}

export async function queryVectorAdapter(
  query: string,
  options: VectorAdapterOptions = {},
): Promise<SearchResult[]> {
  const topK = options.topK ?? 10

  // 1. Resolve runtime context (test injection or env-based)
  const ctx = await resolveVectorContext(options)
  if (!ctx) return []

  // 2. Query LanceDB → map vector rows to search results
  return runVectorQuery(query, topK, options.sessionId, ctx.embeddingClient, ctx.vectorStore)
}

async function runVectorQuery(
  query: string,
  topK: number,
  sessionId: string | undefined,
  embeddingClient: EmbeddingClient,
  vectorStore: LanceDbVectorStore,
): Promise<SearchResult[]> {
  let embedding: number[][]
  try {
    embedding = await embeddingClient.embed([query])
  } catch {
    return []
  }

  if (embedding.length === 0) {
    return []
  }

  let response
  try {
    response = await vectorStore.query(
      {
        query,
        source: OPENCODE_SOURCE,
        mode: "semantic",
        top_k: topK,
      },
      embedding[0],
      { manifestValidated: true },
    )
  } catch {
    return []
  }

  const seen = new Set<string>()
  const output: SearchResult[] = []

  for (const item of response.results) {
    if (item.source !== OPENCODE_SOURCE) continue

    const meta = item.metadata
    const itemSessionID =
      typeof meta.session_id === "string" ? meta.session_id : ""
    if (!itemSessionID) continue

    if (sessionId !== undefined && itemSessionID !== sessionId) continue

    const result = queryResultToSearchResult(item)
    const key = `${result.session_id}:${result.message_id}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(result)
  }

  return output
}
