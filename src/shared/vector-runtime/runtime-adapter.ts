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

function manifestInvalidDiagnostics(backend: VectorBackend): RuntimeDiagnostics {
  return {
    backend,
    manifest_validated: true,
    semantic_available: false,
    reason: "manifest_invalid",
  }
}

function emptyQueryResponse(diagnostics: RuntimeDiagnostics): QueryResponse {
  return { results: [], diagnostics }
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
  env?: ResolvedVectorRuntimeEnv,
): () => Promise<ManifestValidationResult> {
  if (!manifest) {
    return async () => noopValidationResult()
  }
  return async () => validateManifestForSource(manifest, "all", env)
}

function buildQuery(
  diagnostics: RuntimeDiagnostics,
  manifest: ManifestContract | undefined,
  env?: ResolvedVectorRuntimeEnv,
): (request: QueryRequest) => Promise<QueryResponse> {
  return async (request: QueryRequest): Promise<QueryResponse> => {
    const parsed = QueryRequestSchema.safeParse(request)
    if (!parsed.success) {
      return emptyQueryResponse(invalidRequestDiagnostics(diagnostics.backend))
    }

    if (!manifest) {
      return emptyQueryResponse(diagnostics)
    }

    const validation = validateManifestForSource(manifest, request.source, env)
    if (!validation.valid) {
      return emptyQueryResponse(manifestInvalidDiagnostics(diagnostics.backend))
    }

    return emptyQueryResponse({
      ...diagnostics,
      manifest_validated: true,
    })
  }
}

function buildDiagnostics(d: RuntimeDiagnostics): () => RuntimeDiagnostics {
  return () => ({ ...d })
}

function makeQueryRuntime(
  diagnostics: RuntimeDiagnostics,
  manifest?: ManifestContract,
  env?: ResolvedVectorRuntimeEnv,
): QueryRuntime {
  return {
    validate: buildValidate(manifest, env),
    query: buildQuery(diagnostics, manifest, env),
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
      env,
    )
  }

  return createNoopRuntimeAdapter()
}