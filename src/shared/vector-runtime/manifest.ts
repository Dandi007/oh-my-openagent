/**
 * Manifest Loading and Source Validation Layer
 *
 * Phase 5: Resolve manifest path from environment, load and parse the
 * manifest file, and validate source namespace compatibility.
 *
 * All functions return typed result objects — no uncaught parse/read
 * errors leak to callers.
 *
 * @see docs/specs/vector-runtime-contract.md
 */

import type {
  ManifestContract,
  ManifestValidationResult,
  ResolvedVectorRuntimeEnv,
  SourceNamespace,
} from "./types"
import { ManifestSchema } from "./schemas"

// ── Public types ──────────────────────────────────────────────────────

/** Machine-readable reason for manifest load failure. */
export type ManifestLoadErrorReason =
  | "manifest_not_found"
  | "manifest_read_failed"
  | "manifest_malformed_json"
  | "manifest_schema_invalid"

/** Successful manifest load result. */
export interface ManifestLoadOk {
  ok: true
  manifest: ManifestContract
}

/** Failed manifest load result with typed reason and diagnostics. */
export interface ManifestLoadErr {
  ok: false
  reason: ManifestLoadErrorReason
  message: string
  diagnostics?: string[]
}

/** Typed result of loading a manifest file. */
export type ManifestLoadResult = ManifestLoadOk | ManifestLoadErr

// ── Manifest Path Resolution ──────────────────────────────────────────

/**
 * Resolve the manifest file path from the resolved runtime environment.
 *
 * Only uses explicit `env.manifestPath` (from `AGENT_VECTOR_MANIFEST`).
 * Returns `undefined` when no manifest path is configured — there is no
 * implicit fallback to other environment variables or filesystem locations.
 *
 * This function does not hard-code any implementation-specific paths.
 */
export function resolveManifestPath(
  env: ResolvedVectorRuntimeEnv,
): string | undefined {
  if (env.manifestPath) {
    return env.manifestPath
  }
  return undefined
}

// ── Manifest Loading ──────────────────────────────────────────────────

/**
 * Load and validate a manifest file from disk.
 *
 * Returns a typed `ManifestLoadResult` — never throws to the caller.
 * Handles missing file, malformed JSON, and schema validation failure
 * as typed error results.
 */
export async function loadManifest(
  path: string,
): Promise<ManifestLoadResult> {
  let raw: string
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return {
        ok: false,
        reason: "manifest_not_found",
        message: `manifest file not found: ${path}`,
      }
    }
    raw = await file.text()
  } catch (err) {
    return {
      ok: false,
      reason: "manifest_read_failed",
      message: `failed to read manifest file: ${path}: ${String(err)}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      ok: false,
      reason: "manifest_malformed_json",
      message: `manifest file contains malformed JSON: ${path}: ${String(err)}`,
    }
  }

  const result = ManifestSchema.safeParse(parsed)
  if (!result.success) {
    const diagnostics = result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    )
    return {
      ok: false,
      reason: "manifest_schema_invalid",
      message: `manifest schema validation failed: ${path}`,
      diagnostics,
    }
  }

  return { ok: true, manifest: result.data as ManifestContract }
}

// ── Source Validation ─────────────────────────────────────────────────

/**
 * Validate a loaded manifest for runtime compatibility with a target source
 * namespace and optional runtime environment.
 *
 * Structural validation (contract_version, backend enum, embedding fields,
 * source entry fields, source stats, source_sha256) is handled by
 * `ManifestSchema` during `loadManifest()`. This function only performs
 * runtime compatibility checks that cannot be expressed in the static schema:
 *
 * - Backend must match the resolved env backend (when env is provided)
 * - Embedding dimensions must match env.embedding.dimensions (when configured)
 * - For `source !== "all"`: the source namespace must exist in the manifest
 * - Freshness: marks stale when `last_indexed_at` is older than a
 *   deterministic threshold (24 hours)
 * - Invalid `last_indexed_at` format (not parseable as ISO-8601)
 *
 * Returns `ManifestValidationResult` with errors (blocking) and
 * warnings (non-blocking).
 */
export function validateManifestForSource(
  manifest: ManifestContract,
  source: SourceNamespace,
  env?: ResolvedVectorRuntimeEnv,
): ManifestValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Backend compatibility with env (runtime check)
  if (env && manifest.backend !== env.backend) {
    errors.push(
      `manifest backend "${manifest.backend}" does not match resolved backend "${env.backend}"`,
    )
  }

  // Embedding dimension compatibility with env (runtime check)
  if (
    env?.embedding.dimensions !== undefined &&
    manifest.embedding.dimensions !== env.embedding.dimensions
  ) {
    errors.push(
      `manifest embedding dimensions ${manifest.embedding.dimensions} does not match resolved dimensions ${env.embedding.dimensions}`,
    )
  }

  // Source namespace existence (runtime check — depends on query source)
  if (source !== "all") {
    const sourceEntry = manifest.sources[source]
    if (!sourceEntry) {
      errors.push(`source namespace "${source}" not found in manifest sources`)
    } else {
      // Freshness check: warn if last_indexed_at is older than 24 hours
      if (sourceEntry.last_indexed_at) {
        const indexedAt = Date.parse(sourceEntry.last_indexed_at)
        if (!Number.isNaN(indexedAt)) {
          const ageMs = Date.now() - indexedAt
          const staleThresholdMs = 24 * 60 * 60 * 1000 // 24 hours
          if (ageMs > staleThresholdMs) {
            warnings.push(
              `source "${source}" last indexed at ${sourceEntry.last_indexed_at}, may be stale`,
            )
          }
        } else {
          errors.push(
            `source "${source}" last_indexed_at "${sourceEntry.last_indexed_at}" is not a valid ISO-8601 timestamp`,
          )
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
