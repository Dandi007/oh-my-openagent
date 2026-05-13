/**
 * Vector Runtime Contract Types
 *
 * Phase 1-3: Env Contract, Manifest Contract, Query Contract.
 * Pure TypeScript types/interfaces only — no runtime DB, filesystem,
 * or implementation modules.
 *
 * @see docs/specs/vector-runtime-contract.md
 */

// ── Phase 1: Env Contract ────────────────────────────────────────────

/** Supported vector database backends. */
export type VectorBackend = "lancedb" | "qdrant" | "noop"

/**
 * Source namespace for vector rows.
 * Open string alias — source selection belongs to query/source adapter contract,
 * not global env.
 */
export type SourceNamespace = string

/**
 * Resolved runtime environment derived from Env Contract variables.
 * All fields are optional — callers must validate before use.
 * API keys are intentionally excluded from this type to prevent
 * accidental logging or serialization.
 */
export interface ResolvedVectorRuntimeEnv {
  /** Resolved vector backend identifier. */
  backend: VectorBackend
  /** Filesystem backend: local vector database path. */
  dbPath?: string
  /** Service backend: remote vector database URI. */
  dbUri?: string
  /** Manifest file path or URI. */
  manifestPath?: string
  /** Embedding configuration resolved from environment. */
  embedding: {
    /** Embedding API endpoint. */
    endpoint?: string
    /** Embedding model identifier. */
    model?: string
    /** Embedding vector dimension count. */
    dimensions?: number
  }
  /** Query or write operation timeout budget in milliseconds. */
  timeoutMs?: number
}

// ── Phase 2: Manifest Contract ───────────────────────────────────────

/** Embedding settings recorded in the manifest. */
export interface ManifestEmbeddingContract {
  /** Embedding provider type (e.g. "http"). */
  provider: string
  /** Embedding API endpoint URL. */
  endpoint: string
  /** Embedding model identifier. */
  model: string
  /** Embedding vector dimension count. */
  dimensions: number
}

/** Per-source metadata in the manifest. */
export interface ManifestSourceContract {
  /** Vector table name for this source namespace. */
  table: string
  /** Schema version identifier for this source's row format. */
  schema_version: string
  /** Canonical source-of-truth category: "database" or "external-system". */
  source_of_truth: string
  /** ISO-8601 timestamp of last successful index. */
  last_indexed_at: string
  /** Number of source sessions observed during the build. */
  sessions: number
  /** Number of source messages observed during the build. */
  messages: number
  /** Number of source parts observed during the build. */
  parts: number
  /** Number of chunks written for this source. */
  chunks: number
  /** Source database/file size in bytes at build time. */
  source_bytes: number
  /** Source database/file SHA-256 digest at build time. */
  source_sha256: string
}

/**
 * Manifest is the compatibility checkpoint between query vectors,
 * stored vectors, source schemas, and writer behavior.
 * Runtime must validate manifest before returning semantic results
 * or executing writes.
 */
export interface ManifestContract {
  /** Contract version identifier. */
  contract_version: "vector-runtime/v1"
  /** Active vector backend. */
  backend: VectorBackend
  /** Vector database path (filesystem backends). */
  db_path: string
  /** Embedding configuration. */
  embedding: ManifestEmbeddingContract
  /** Per-source namespace configuration. */
  sources: Record<string, ManifestSourceContract>
}

/** Result of manifest validation. */
export interface ManifestValidationResult {
  /** Whether the manifest passes all compatibility checks. */
  valid: boolean
  /** Blocking validation errors. */
  errors: string[]
  /** Non-blocking validation warnings. */
  warnings: string[]
}

// ── Phase 3: Query Contract ──────────────────────────────────────────

/** Query execution mode. */
export type QueryMode = "semantic" | "keyword" | "hybrid"

/** Normalized query request submitted by callers. */
export interface QueryRequest {
  /** Natural language query text. */
  query: string
  /** Source namespace to query. */
  source: SourceNamespace
  /** Query execution mode. */
  mode: QueryMode
  /** Maximum number of results to return. */
  top_k: number
  /** Optional source-specific filters (e.g. session_id). */
  filters?: Record<string, string>
}

/** A single query result row. */
export interface QueryResult {
  /** Source namespace of this result. */
  source: SourceNamespace
  /** Deterministic chunk identifier. */
  chunk_id: string
  /** Similarity score (0-1). */
  score: number
  /** Matched chunk text. */
  text: string
  /** Source-specific structured metadata. */
  metadata: Record<string, unknown>
}

/** Runtime diagnostics returned with query results. */
export interface RuntimeDiagnostics {
  /** Active vector backend. */
  backend: VectorBackend
  /** Whether manifest was validated before query. */
  manifest_validated: boolean
  /** Whether semantic search is available. */
  semantic_available: boolean
  /** Optional machine-readable reason for the diagnostic state. */
  reason?: string
}

/** Normalized query response returned by the runtime adapter. */
export interface QueryResponse {
  /** Ordered list of query results. */
  results: QueryResult[]
  /** Runtime diagnostics. */
  diagnostics: RuntimeDiagnostics
}
