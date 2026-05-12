/**
 * Deterministic Env Contract Resolver
 *
 * Parses Vector Runtime Contract environment variables into a typed
 * ResolvedVectorRuntimeEnv.  Callers inject an env map so tests never
 * mutate global process.env; the thin process.env wrapper only fires
 * when the caller omits the `input` parameter.
 *
 * API keys (AGENT_VECTOR_DB_API_KEY, AGENT_EMBEDDING_API_KEY) are
 * intentionally excluded from the returned object per the Security
 * Contract.
 *
 * @see docs/specs/vector-runtime-contract.md
 */

import type { ResolvedVectorRuntimeEnv, VectorBackend } from "./types"

// ── Public types ──────────────────────────────────────────────────────

/** Result of resolving the Env Contract. */
export interface EnvResolutionResult {
  /** Resolved runtime environment (always present, never throws). */
  env: ResolvedVectorRuntimeEnv
  /** Non-blocking diagnostics for invalid / missing configuration. */
  diagnostics: string[]
}

// ── Constants ─────────────────────────────────────────────────────────

const VALID_BACKENDS: ReadonlySet<string> = new Set(["lancedb", "qdrant", "noop"])

/** Env var keys that constitute "vector config present". */
const VECTOR_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "AGENT_VECTOR_DB_BACKEND",
  "AGENT_VECTOR_DB_PATH",
  "AGENT_VECTOR_DB_URI",
  "AGENT_VECTOR_MANIFEST",
  "AGENT_EMBEDDING_ENDPOINT",
  "AGENT_EMBEDDING_MODEL",
  "AGENT_EMBEDDING_DIMENSIONS",
  "AGENT_VECTOR_SOURCE",
  "AGENT_VECTOR_TIMEOUT_MS",
])

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse a positive integer from a raw env string.
 * Returns `undefined` for missing / empty / invalid values and
 * attaches a diagnostic when the value is present but malformed.
 */
function parsePositiveInt(
  raw: string | undefined,
  label: string,
): { value: number | undefined; diagnostic?: string } {
  if (raw === undefined || raw.trim() === "") {
    return { value: undefined }
  }
  const trimmed = raw.trim()
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return {
      value: undefined,
      diagnostic: `${label} must be a positive integer, got "${trimmed}"`,
    }
  }
  return { value: parsed }
}

/**
 * Resolve a backend identifier from a raw env string.
 * Unknown values produce a diagnostic and fall back to "noop".
 */
function resolveBackend(raw: string | undefined): { backend: VectorBackend; diagnostic?: string } {
  if (raw === undefined || raw.trim() === "") {
    return { backend: "noop" }
  }
  const trimmed = raw.trim()
  if (VALID_BACKENDS.has(trimmed)) {
    return { backend: trimmed as VectorBackend }
  }
  return {
    backend: "noop",
    diagnostic: `AGENT_VECTOR_DB_BACKEND "${trimmed}" is not a supported backend; falling back to "noop"`,
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Deterministically resolve the Vector Runtime Env Contract from an
 * optional env map.
 *
 * When `input` is omitted the resolver reads `process.env` directly.
 * Tests should always pass an explicit `input` map to avoid coupling
 * to the host environment.
 *
 * API keys (`AGENT_VECTOR_DB_API_KEY`, `AGENT_EMBEDDING_API_KEY`) are
 * deliberately **not** read — they must be consumed by the runtime
 * adapter directly and never appear in serializable config or
 * diagnostics.
 */
export function resolveVectorRuntimeEnv(
  input?: Record<string, string | undefined>,
): EnvResolutionResult {
  const source: Record<string, string | undefined> =
    input ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {})

  const diagnostics: string[] = []

  // Backend
  const { backend, diagnostic: backendDiag } = resolveBackend(source["AGENT_VECTOR_DB_BACKEND"])
  if (backendDiag) diagnostics.push(backendDiag)

  // Numeric fields
  const dimsResult = parsePositiveInt(source["AGENT_EMBEDDING_DIMENSIONS"], "AGENT_EMBEDDING_DIMENSIONS")
  if (dimsResult.diagnostic) diagnostics.push(dimsResult.diagnostic)

  const timeoutResult = parsePositiveInt(source["AGENT_VECTOR_TIMEOUT_MS"], "AGENT_VECTOR_TIMEOUT_MS")
  if (timeoutResult.diagnostic) diagnostics.push(timeoutResult.diagnostic)

  // Assemble resolved env — API keys are intentionally excluded
  const env: ResolvedVectorRuntimeEnv = {
    knowledgeRoot: source["AGENT_KNOWLEDGE_ROOT"]?.trim() || undefined,
    backend,
    dbPath: source["AGENT_VECTOR_DB_PATH"]?.trim() || undefined,
    dbUri: source["AGENT_VECTOR_DB_URI"]?.trim() || undefined,
    manifestPath: source["AGENT_VECTOR_MANIFEST"]?.trim() || undefined,
    embedding: {
      endpoint: source["AGENT_EMBEDDING_ENDPOINT"]?.trim() || undefined,
      model: source["AGENT_EMBEDDING_MODEL"]?.trim() || undefined,
      dimensions: dimsResult.value,
    },
    source: source["AGENT_VECTOR_SOURCE"]?.trim() || undefined,
    timeoutMs: timeoutResult.value,
  }

  // Missing vector config → explicit no-op / semantic-unavailable diagnostic
  const hasConfig = VECTOR_CONFIG_KEYS.values().some((key) => {
    const raw = source[key]
    return raw !== undefined && raw.trim() !== ""
  })
  if (!hasConfig) {
    diagnostics.push(
      "vector_config_missing: no vector backend or embedding configuration detected; semantic search is unavailable",
    )
  }

  return { env, diagnostics }
}