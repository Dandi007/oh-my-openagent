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
 * Priority:
 * 1. `env.manifestPath` (from `AGENT_VECTOR_MANIFEST`)
 * 2. `${env.knowledgeRoot}/vector-manifest.json` (from `AGENT_KNOWLEDGE_ROOT`)
 * 3. `undefined` — no manifest path available
 *
 * This function does not hard-code home, iCloud, or Search Note paths.
 */
export function resolveManifestPath(
  env: ResolvedVectorRuntimeEnv,
): string | undefined {
  if (env.manifestPath) {
    return env.manifestPath
  }
  if (env.knowledgeRoot) {
    return `${env.knowledgeRoot}/vector-manifest.json`
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
 * Validate a loaded manifest for compatibility with a target source
 * namespace and optional runtime environment.
 *
 * Checks performed:
 * - Contract version must be "vector-runtime/v1"
 * - Backend must match the resolved env backend (when env is provided)
 * - Embedding model and dimensions must be present
 * - For `source !== "all"`: the source namespace must exist in the manifest
 * - Source entry must have non-empty table, schema_version, source_of_truth
 * - Freshness: marks stale when `last_indexed_at` is older than a
 *   deterministic threshold (24 hours)
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

  // INV-1: contract version
  if (manifest.contract_version !== "vector-runtime/v1") {
    errors.push(
      `unsupported contract version: ${manifest.contract_version}, expected "vector-runtime/v1"`,
    )
  }

  // Backend compatibility with env
  if (env && manifest.backend !== env.backend) {
    errors.push(
      `manifest backend "${manifest.backend}" does not match resolved backend "${env.backend}"`,
    )
  }

  // Embedding fields must be present
  if (!manifest.embedding.model || manifest.embedding.model.trim() === "") {
    errors.push("manifest embedding model is missing or empty")
  }
  if (
    !manifest.embedding.dimensions ||
    manifest.embedding.dimensions <= 0 ||
    !Number.isInteger(manifest.embedding.dimensions)
  ) {
    errors.push(
      `manifest embedding dimensions is invalid: ${manifest.embedding.dimensions}`,
    )
  }

  // Source namespace validation
  if (source !== "all") {
    const sourceEntry = manifest.sources[source]
    if (!sourceEntry) {
      errors.push(`source namespace "${source}" not found in manifest sources`)
    } else {
      // Validate source entry fields
      if (!sourceEntry.table || sourceEntry.table.trim() === "") {
        errors.push(`source "${source}" table is missing or empty`)
      }
      if (
        !sourceEntry.schema_version ||
        sourceEntry.schema_version.trim() === ""
      ) {
        errors.push(`source "${source}" schema_version is missing or empty`)
      }
      if (
        !sourceEntry.source_of_truth ||
        sourceEntry.source_of_truth.trim() === ""
      ) {
        errors.push(`source "${source}" source_of_truth is missing or empty`)
      }

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
          warnings.push(
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