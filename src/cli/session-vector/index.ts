import { Command } from "commander"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveVectorRuntimeEnv } from "../../shared/vector-runtime/env"
import { createHttpEmbeddingClient } from "../../shared/vector-runtime/embedding-client"
import { buildOpenCodeSessionVectorIndex } from "../../tools/session-manager/vector-build"
import { getDBPath } from "../../tools/session-manager/sql-search"
import type { ManifestEmbeddingContract } from "../../shared/vector-runtime/types"

const OPENCODE_SOURCE = "opencode"

function parsePositiveInt(value: string): number {
  if (/^[1-9][0-9]*$/.test(value)) {
    return Number(value)
  }
  return NaN
}

function getCacheDir(): string {
  const xdgCache = process.env.XDG_CACHE_HOME?.trim()
  if (xdgCache) return join(xdgCache, "oh-my-opencode", "vector")
  return join(homedir(), ".cache", "oh-my-opencode", "vector")
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function resolveDefaultIndexPath(): string {
  const cacheDir = getCacheDir()
  ensureDir(cacheDir)
  return join(cacheDir, "opencode-sessions")
}

function resolveDefaultManifestPath(): string {
  const cacheDir = getCacheDir()
  ensureDir(cacheDir)
  return join(cacheDir, "vector-manifest.json")
}

interface BuildOutput {
  chunks_indexed: number
  source_namespace: string
  manifest_path: string
  index_path: string
  indexed_at: string
  stats: {
    sessions: number
    messages: number
    parts: number
    source_bytes: number
    source_sha256: string
  }
}

export function createSessionVectorCommand(): Command {
  const command = new Command("session-vector")
    .description("Manage OpenCode session vector index")

  command
    .command("build")
    .description("Build a derived vector index from OpenCode session data")
    .option("--db <path>", "Path to OpenCode SQLite source database")
    .option("--index <path>", "Path for the vector index output directory")
    .option("--manifest <path>", "Path for the vector manifest JSON file")
    .option("--limit <n>", "Limit number of sessions to index (debug/fixture)", parsePositiveInt)
    .option("--json", "Output results as machine-parseable JSON")
    .addHelpText("after", `
Examples:
  $ bunx oh-my-opencode session-vector build
  $ bunx oh-my-opencode session-vector build --db /path/to/opencode.db
  $ bunx oh-my-opencode session-vector build --index /tmp/my-index --json

Environment:
  AGENT_EMBEDDING_ENDPOINT   Embedding API endpoint (required)
  AGENT_EMBEDDING_MODEL      Embedding model name (required)
  AGENT_EMBEDDING_DIMENSIONS Embedding vector dimensions (required)
  AGENT_EMBEDDING_API_KEY    Embedding API key (optional)
  AGENT_VECTOR_DB_PATH       Default vector index path (overridden by --index)
  AGENT_VECTOR_MANIFEST      Default manifest path (overridden by --manifest)
  OPENCODE_DB                Default source database path (overridden by --db)
`)
    .action(async (options) => {
      try {
        // Resolve source DB path
        const sourceDbPath: string = options.db ?? getDBPath()
        if (!existsSync(sourceDbPath)) {
          throw new Error(`source OpenCode database not found: ${sourceDbPath}`)
        }

        // Resolve index path: explicit --index > AGENT_VECTOR_DB_PATH > cache default
        const indexPath: string =
          options.index ??
          process.env.AGENT_VECTOR_DB_PATH?.trim() ??
          resolveDefaultIndexPath()

        // Resolve manifest path: explicit --manifest > AGENT_VECTOR_MANIFEST > cache default
        const manifestPath: string =
          options.manifest ??
          process.env.AGENT_VECTOR_MANIFEST?.trim() ??
          resolveDefaultManifestPath()

        // Ensure parent directory exists for index and manifest
        const indexParent = join(indexPath, "..")
        ensureDir(indexParent)
        const manifestParent = join(manifestPath, "..")
        ensureDir(manifestParent)

        // Resolve embedding config from environment
        const { env, diagnostics } = resolveVectorRuntimeEnv()
        if (!env.embedding.endpoint) {
          throw new Error(
            "embedding endpoint is not configured: set AGENT_EMBEDDING_ENDPOINT",
          )
        }
        if (!env.embedding.model) {
          throw new Error(
            "embedding model is not configured: set AGENT_EMBEDDING_MODEL",
          )
        }
        if (!env.embedding.dimensions || env.embedding.dimensions <= 0) {
          throw new Error(
            "embedding dimensions not configured: set AGENT_EMBEDDING_DIMENSIONS to a positive integer",
          )
        }

        // Validate --limit if provided
        const rawLimit = options.limit
        if (rawLimit !== undefined) {
          if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
            throw new Error(
              `--limit must be a positive integer, got ${rawLimit}`,
            )
          }
        }

        const embeddingClient = createHttpEmbeddingClient(env)

        const embedding: ManifestEmbeddingContract = {
          provider: "http",
          endpoint: env.embedding.endpoint,
          model: env.embedding.model,
          dimensions: env.embedding.dimensions,
        }

        const result = await buildOpenCodeSessionVectorIndex({
          sourceDbPath,
          vectorDbPath: indexPath,
          manifestPath,
          embeddingClient,
          embedding,
          limitSessions: rawLimit,
        })

        const output: BuildOutput = {
          chunks_indexed: result.stats.chunks,
          source_namespace: OPENCODE_SOURCE,
          manifest_path: manifestPath,
          index_path: indexPath,
          indexed_at: result.manifest.sources[OPENCODE_SOURCE]?.last_indexed_at ?? "",
          stats: {
            sessions: result.stats.sessions,
            messages: result.stats.messages,
            parts: result.stats.parts,
            source_bytes: result.stats.source_bytes,
            source_sha256: result.stats.source_sha256,
          },
        }

        if (options.json) {
          console.log(JSON.stringify(output))
        } else {
          console.log(`Vector index built successfully.`)
          console.log(`  Chunks indexed:  ${output.chunks_indexed}`)
          console.log(`  Source namespace: ${output.source_namespace}`)
          console.log(`  Sessions:         ${output.stats.sessions}`)
          console.log(`  Messages:         ${output.stats.messages}`)
          console.log(`  Parts:            ${output.stats.parts}`)
          console.log(`  Source DB:        ${output.stats.source_bytes} bytes (sha256: ${output.stats.source_sha256.slice(0, 16)}...)`)
          console.log(`  Index path:       ${output.index_path}`)
          console.log(`  Manifest path:    ${output.manifest_path}`)
          console.log(`  Indexed at:       ${output.indexed_at}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (options.json) {
          console.log(JSON.stringify({ error: message }))
        } else {
          console.error(`Error: ${message}`)
        }
        process.exit(1)
      }
    })

  return command
}