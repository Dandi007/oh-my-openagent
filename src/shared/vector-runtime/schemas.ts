/**
 * Vector Runtime Contract Zod Schemas
 *
 * Phase 4: Runtime validation for Manifest and Query contracts.
 * Pure Zod schemas — no DB, filesystem, or implementation modules.
 *
 * @see docs/specs/vector-runtime-contract.md
 */

import { z } from "zod"

// ── Shared Primitives ─────────────────────────────────────────────────

const vectorBackendSchema = z.enum(["lancedb", "qdrant", "noop"])

const positiveIntSchema = z.number().int().positive()
const nonNegativeIntSchema = z.number().int().nonnegative()
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

// ── Manifest Contract Schemas ─────────────────────────────────────────

/** Schema for a single source entry in the manifest. */
export const ManifestSourceSchema = z.object({
  table: z.string().min(1),
  schema_version: z.string().min(1),
  source_of_truth: z.enum(["database", "external-system"]),
  last_indexed_at: z.string().min(1),
  sessions: nonNegativeIntSchema,
  messages: nonNegativeIntSchema,
  parts: nonNegativeIntSchema,
  chunks: nonNegativeIntSchema,
  source_bytes: nonNegativeIntSchema,
  source_sha256: sha256Schema,
}).strict()

/** Schema for embedding configuration in the manifest. */
const ManifestEmbeddingSchema = z.object({
  provider: z.string().min(1),
  endpoint: z.string().min(1),
  model: z.string().min(1),
  dimensions: positiveIntSchema,
}).strict()

/**
 * Full manifest schema.
 *
 * Invariants enforced:
 * - contract_version must be exactly "vector-runtime/v1"
 * - backend must be one of lancedb | qdrant | noop
 * - embedding.dimensions must be a positive integer
 * - sources must be a non-empty record of valid source entries
 */
export const ManifestSchema = z.object({
  contract_version: z.literal("vector-runtime/v1"),
  backend: vectorBackendSchema,
  db_path: z.string().min(1),
  embedding: ManifestEmbeddingSchema,
  sources: z.record(z.string().min(1), ManifestSourceSchema).refine(
    (sources) => Object.keys(sources).length > 0,
    { message: "sources must contain at least one source namespace" },
  ),
}).strict()

// ── Query Contract Schemas ────────────────────────────────────────────

const queryModeSchema = z.enum(["semantic", "keyword", "hybrid"])

/**
 * Query request schema.
 *
 * Invariants enforced:
 * - mode must be semantic | keyword | hybrid
 * - top_k must be a positive integer between 1 and 100 (inclusive)
 * - query text must be non-empty
 * - source must be a non-empty string
 */
export const QueryRequestSchema = z.object({
  query: z.string().min(1),
  source: z.string().min(1),
  mode: queryModeSchema,
  top_k: positiveIntSchema.max(100),
  filters: z.record(z.string(), z.string()).optional(),
}).strict()

/** Schema for a single query result row. */
const QueryResultSchema = z.object({
  source: z.string().min(1),
  chunk_id: z.string().min(1),
  score: z.number().min(0).max(1),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()),
}).strict()

/**
 * Runtime diagnostics schema.
 *
 * Security: must not contain credentials (API keys, secrets).
 */
export const RuntimeDiagnosticsSchema = z.object({
  backend: vectorBackendSchema,
  manifest_validated: z.boolean(),
  semantic_available: z.boolean(),
  reason: z.string().optional(),
}).strict()

/**
 * Query response schema.
 */
export const QueryResponseSchema = z.object({
  results: z.array(QueryResultSchema),
  diagnostics: RuntimeDiagnosticsSchema,
}).strict()
