import { existsSync } from "node:fs"
import type { SearchResult } from "./types"
import { resolveVectorRuntimeEnv } from "../../shared/vector-runtime/env"
import {
  resolveManifestPath,
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

interface VectorAdapterOptions {
  topK?: number
  sessionId?: string
  timeoutMs?: number
  _env?: Record<string, string | undefined>
  _embeddingClient?: EmbeddingClient
  _vectorStore?: LanceDbVectorStore
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

  if (options._embeddingClient !== undefined && options._vectorStore !== undefined) {
    return runVectorQuery(
      query,
      topK,
      options.sessionId,
      options._embeddingClient,
      options._vectorStore,
    )
  }

  const envInput = buildEnvInput(options._env, options.timeoutMs)
  const { env } = resolveVectorRuntimeEnv(envInput)

  if (env.backend !== "lancedb") {
    return []
  }

  if (!env.dbPath) {
    return []
  }

  if (!env.embedding.endpoint) {
    return []
  }

  if (!existsSync(env.dbPath)) {
    return []
  }

  const manifestPath = resolveManifestPath(env)
  if (!manifestPath) {
    return []
  }

  const manifestResult = await loadManifest(manifestPath)
  if (!manifestResult.ok) {
    return []
  }

  const validation = validateManifestForSource(
    manifestResult.manifest,
    OPENCODE_SOURCE,
    env,
  )
  if (!validation.valid) {
    return []
  }

  const sourceEntry = manifestResult.manifest.sources[OPENCODE_SOURCE]
  if (!sourceEntry) {
    return []
  }

  const embeddingClient = createHttpEmbeddingClient(env)
  const vectorStore = createLanceDbVectorStore({
    dbPath: env.dbPath,
    tableName: sourceEntry.table,
  })

  return runVectorQuery(query, topK, options.sessionId, embeddingClient, vectorStore)
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