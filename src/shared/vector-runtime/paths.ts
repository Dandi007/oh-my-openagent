/**
 * Centralized Vector Path and Config Resolver
 *
 * Combines env resolution (from env.ts) with default cache path resolution
 * (from cache-paths.ts) into a single call site.  Both the CLI build path
 * and the query vector adapter path consume this resolver instead of
 * duplicating path fallback logic.
 *
 * Precedence: explicit CLI flags > env vars > default cache paths.
 *
 * @see docs/specs/vector-runtime-contract.md
 */

import { resolveVectorRuntimeEnv } from "./env"
import { getDefaultVectorCachePaths } from "./cache-paths"
import type { VectorBackend } from "./types"

// ── Public types ──────────────────────────────────────────────────────

/** Explicit path overrides (typically from CLI flags). */
export interface VectorPathOverrides {
  /** Explicit index path override. */
  indexPath?: string
  /** Explicit manifest path override. */
  manifestPath?: string
}

/**
 * Fully resolved vector runtime configuration.
 *
 * Combines env resolution, default cache paths, and explicit overrides
 * into a single normalized result.  API keys are intentionally excluded.
 */
export interface ResolvedVectorConfig {
  /** Resolved vector index directory path. */
  indexPath: string
  /** Resolved manifest file path. */
  manifestPath: string
  /** Resolved vector backend identifier. */
  backend: VectorBackend
  /** Resolved embedding configuration. */
  embedding: {
    endpoint?: string
    model?: string
    dimensions?: number
  }
  /** Resolved timeout budget in milliseconds. */
  timeoutMs?: number
  /** Non-blocking diagnostics from env resolution. */
  diagnostics: string[]
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Resolve the full vector runtime configuration.
 *
 * Combines `resolveVectorRuntimeEnv` and `getDefaultVectorCachePaths`
 * with explicit path overrides.  Precedence is:
 *
 *   1. `overrides.indexPath` / `overrides.manifestPath`
 *   2. `AGENT_VECTOR_DB_PATH` / `AGENT_VECTOR_MANIFEST` env vars
 *   3. Default cache paths under `XDG_CACHE_HOME`
 *
 * When `cacheOptions.createDirectories` is `true`, the cache directory
 * is created if it does not exist (used by the CLI build path).
 *
 * API keys (`AGENT_VECTOR_DB_API_KEY`, `AGENT_EMBEDDING_API_KEY`) are
 * intentionally excluded from the returned object.
 */
export function resolveVectorConfig(
  overrides?: VectorPathOverrides,
  envInput?: Record<string, string | undefined>,
  cacheOptions?: { createDirectories?: boolean },
): ResolvedVectorConfig {
  const { env, diagnostics } = resolveVectorRuntimeEnv(envInput)
  const defaultPaths = getDefaultVectorCachePaths(envInput, cacheOptions)

  // Precedence: explicit overrides > env vars > default cache paths
  const indexPath = overrides?.indexPath ?? env.dbPath ?? defaultPaths.indexPath
  const manifestPath =
    overrides?.manifestPath ?? env.manifestPath ?? defaultPaths.manifestPath

  return {
    indexPath,
    manifestPath,
    backend: env.backend,
    embedding: env.embedding,
    timeoutMs: env.timeoutMs,
    diagnostics,
  }
}