/**
 * Vector Runtime Adapter — Query Runtime Interface and Factory
 *
 * Phase 6: Defines the QueryRuntime interface, a no-op adapter for
 * environments without a configured vector backend, and a factory
 * that routes to the correct adapter based on environment and manifest.
 *
 * Write-scope methods (delta application, chunk embedding, manifest commits)
 * are intentionally excluded from this refactor slice.
 *
 * @see docs/specs/vector-runtime-contract.md
 */

import type {
  ManifestContract,
  ManifestValidationResult,
  QueryRequest,
  QueryResponse,
  ResolvedVectorRuntimeEnv,
  RuntimeDiagnostics,
  VectorBackend,
} from "./types"
import { QueryRequestSchema } from "./schemas"
import { validateManifestForSource } from "./manifest"

const DEFAULT_NOOP_DIAGNOSTICS: RuntimeDiagnostics = {
  backend: "noop",
  manifest_validated: false,
  semantic_available: false,
  reason: "noop_adapter",
}

const NOT_IMPLEMENTED_REASON = "backend_not_implemented_in_current_refactor"

function notImplementedDiagnostics(backend: VectorBackend): RuntimeDiagnostics {
  return {
    backend,
    manifest_validated: false,
    semantic_available: false,
    reason: NOT_IMPLEMENTED_REASON,
  }
}

function invalidRequestDiagnostics(backend: VectorBackend): RuntimeDiagnostics {
  return {
    backend,
    manifest_validated: false,
    semantic_available: false,
    reason: "invalid_query_request",
  }
}

function emptyQueryResponse(diagnostics: RuntimeDiagnostics): QueryResponse {
  return { results: [], diagnostics }
}

function noManifestValidationResult(): ManifestValidationResult {
  return {
    valid: false,
    errors: ["no manifest provided"],
    warnings: [],
  }
}

function noopValidationResult(): ManifestValidationResult {
  return {
    valid: false,
    errors: ["noop adapter: no manifest to validate"],
    warnings: [],
  }
}

function buildValidate(
  manifest: ManifestContract | undefined,
  source: string | undefined,
): () => Promise<ManifestValidationResult> {
  if (!manifest) {
    return async () => noopValidationResult()
  }
  const targetSource = source || "all"
  return async () => validateManifestForSource(manifest, targetSource)
}

function buildQuery(
  diagnostics: RuntimeDiagnostics,
  manifest: ManifestContract | undefined,
  source: string | undefined,
): (request: QueryRequest) => Promise<QueryResponse> {
  return async (request: QueryRequest): Promise<QueryResponse> => {
    const parsed = QueryRequestSchema.safeParse(request)
    if (!parsed.success) {
      return emptyQueryResponse(invalidRequestDiagnostics(diagnostics.backend))
    }
    return emptyQueryResponse(diagnostics)
  }
}

function buildDiagnostics(d: RuntimeDiagnostics): () => RuntimeDiagnostics {
  return () => ({ ...d })
}

function makeQueryRuntime(
  diagnostics: RuntimeDiagnostics,
  manifest?: ManifestContract,
  source?: string,
): QueryRuntime {
  return {
    validate: buildValidate(manifest, source),
    query: buildQuery(diagnostics, manifest, source),
    diagnostics: buildDiagnostics(diagnostics),
  }
}

export interface QueryRuntime {
  validate(): Promise<ManifestValidationResult>
  query(request: QueryRequest): Promise<QueryResponse>
  diagnostics(): RuntimeDiagnostics
}

export type RuntimeAdapter = QueryRuntime

export function createNoopRuntimeAdapter(
  diagnostics?: Partial<RuntimeDiagnostics>,
): QueryRuntime {
  const merged: RuntimeDiagnostics = {
    ...DEFAULT_NOOP_DIAGNOSTICS,
    ...diagnostics,
    backend: "noop",
  }
  return makeQueryRuntime(merged)
}

export function createRuntimeAdapter(
  env: ResolvedVectorRuntimeEnv,
  manifest?: ManifestContract,
): QueryRuntime {
  if (!manifest || manifest.backend === "noop") {
    return createNoopRuntimeAdapter()
  }

  if (manifest.backend === "lancedb" || manifest.backend === "qdrant") {
    return makeQueryRuntime(
      notImplementedDiagnostics(manifest.backend),
      manifest,
      env.source,
    )
  }

  return createNoopRuntimeAdapter()
}