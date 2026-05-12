import { describe, expect, it, afterEach } from "bun:test"
import { join } from "node:path"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import {
  resolveManifestPath,
  loadManifest,
  validateManifestForSource,
} from "./manifest"
import type {
  ManifestContract,
  ManifestValidationResult,
  ResolvedVectorRuntimeEnv,
} from "./types"

// ── Test helpers ──────────────────────────────────────────────────────

function makeEnv(
  overrides: Partial<ResolvedVectorRuntimeEnv> = {},
): ResolvedVectorRuntimeEnv {
  return {
    backend: "lancedb",
    embedding: {},
    ...overrides,
  }
}

function makeValidManifest(
  overrides: Partial<ManifestContract> = {},
): ManifestContract {
  return {
    contract_version: "vector-runtime/v1",
    backend: "lancedb",
    db_path: "/tmp/test-lancedb",
    embedding: {
      provider: "http",
      endpoint: "http://localhost:8080/v1/embeddings",
      model: "BAAI/bge-small-zh-v1.5",
      dimensions: 512,
    },
    sources: {
      opencode: {
        table: "opencode_sessions",
        schema_version: "opencode-session-chunk/v1",
        source_of_truth: "opencode.db",
        last_indexed_at: new Date().toISOString(),
      },
      markdown: {
        table: "chunks",
        schema_version: "markdown-chunk/v1",
        source_of_truth: "filesystem",
        last_indexed_at: new Date().toISOString(),
      },
    },
    ...overrides,
  }
}

function writeTempManifest(content: string): string {
  const dir = join(tmpdir(), `omo-test-${randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, "vector-manifest.json")
  writeFileSync(filePath, content, "utf-8")
  return filePath
}

function writeTempManifestJson(data: unknown): string {
  return writeTempManifest(JSON.stringify(data))
}

const tempDirs: string[] = []

function trackTempDir(filePath: string): string {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"))
  tempDirs.push(dir)
  return filePath
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── resolveManifestPath ───────────────────────────────────────────────

describe("resolveManifestPath", () => {
  // #given an env with AGENT_VECTOR_MANIFEST set
  // #when resolveManifestPath is called
  // #then it returns the explicit manifest path
  it("returns explicit manifestPath when set", () => {
    const env = makeEnv({ manifestPath: "/custom/path/manifest.json" })
    expect(resolveManifestPath(env)).toBe("/custom/path/manifest.json")
  })

  // #given an env with manifestPath and knowledgeRoot both set
  // #when resolveManifestPath is called
  // #then manifestPath takes priority over knowledgeRoot
  it("prioritizes manifestPath over knowledgeRoot", () => {
    const env = makeEnv({
      manifestPath: "/explicit/manifest.json",
      knowledgeRoot: "/some/knowledge/root",
    })
    expect(resolveManifestPath(env)).toBe("/explicit/manifest.json")
  })

  // #given an env with only knowledgeRoot set
  // #when resolveManifestPath is called
  // #then it returns knowledgeRoot/vector-manifest.json
  it("falls back to knowledgeRoot/vector-manifest.json", () => {
    const env = makeEnv({ knowledgeRoot: "/data/agent-knowledge" })
    expect(resolveManifestPath(env)).toBe(
      "/data/agent-knowledge/vector-manifest.json",
    )
  })

  // #given an env with neither manifestPath nor knowledgeRoot
  // #when resolveManifestPath is called
  // #then it returns undefined
  it("returns undefined when neither manifestPath nor knowledgeRoot is set", () => {
    const env = makeEnv()
    expect(resolveManifestPath(env)).toBeUndefined()
  })

  // #given an env with empty string manifestPath and no knowledgeRoot
  // #when resolveManifestPath is called
  // #then it returns undefined (empty string is falsy)
  it("returns undefined for empty manifestPath and no knowledgeRoot", () => {
    const env = makeEnv({ manifestPath: "" })
    expect(resolveManifestPath(env)).toBeUndefined()
  })

  // #given an env with empty string knowledgeRoot and no manifestPath
  // #when resolveManifestPath is called
  // #then it returns undefined (empty string is falsy)
  it("returns undefined for empty knowledgeRoot and no manifestPath", () => {
    const env = makeEnv({ knowledgeRoot: "" })
    expect(resolveManifestPath(env)).toBeUndefined()
  })
})

// ── loadManifest ──────────────────────────────────────────────────────

describe("loadManifest", () => {
  // #given a valid manifest file on disk
  // #when loadManifest is called
  // #then it returns ok: true with the parsed manifest
  it("loads a valid manifest successfully", async () => {
    const manifest = makeValidManifest()
    const filePath = trackTempDir(writeTempManifestJson(manifest))

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.contract_version).toBe("vector-runtime/v1")
      expect(result.manifest.backend).toBe("lancedb")
      expect(result.manifest.sources.opencode).toBeDefined()
      expect(result.manifest.sources.markdown).toBeDefined()
    }
  })

  // #given a manifest file that does not exist
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_not_found"
  it("returns error for missing file", async () => {
    const result = await loadManifest("/nonexistent/path/manifest.json")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_not_found")
      expect(result.message).toContain("/nonexistent/path/manifest.json")
    }
  })

  // #given a file containing malformed JSON
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_malformed_json"
  it("returns error for malformed JSON", async () => {
    const filePath = trackTempDir(writeTempManifest("{ not valid json {{{"))

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_malformed_json")
    }
  })

  // #given a file with valid JSON that fails schema validation (missing contract_version)
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_schema_invalid" and diagnostics
  it("returns error for schema validation failure", async () => {
    const filePath = trackTempDir(
      writeTempManifestJson({ backend: "lancedb", db_path: "/tmp" }),
    )

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_schema_invalid")
      expect(result.diagnostics).toBeDefined()
      expect(result.diagnostics!.length).toBeGreaterThan(0)
    }
  })

  // #given a manifest with an unsupported backend
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_schema_invalid"
  it("rejects manifest with unsupported backend", async () => {
    const invalid = makeValidManifest({ backend: "pinecone" as never })
    const filePath = trackTempDir(writeTempManifestJson(invalid))

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_schema_invalid")
    }
  })

  // #given a manifest with zero embedding dimensions
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_schema_invalid"
  it("rejects manifest with zero embedding dimensions", async () => {
    const invalid = makeValidManifest()
    invalid.embedding.dimensions = 0
    const filePath = trackTempDir(writeTempManifestJson(invalid))

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_schema_invalid")
    }
  })

  // #given a manifest with empty sources
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_schema_invalid"
  it("rejects manifest with empty sources", async () => {
    const invalid = makeValidManifest({ sources: {} })
    const filePath = trackTempDir(writeTempManifestJson(invalid))

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_schema_invalid")
    }
  })

  // #given a manifest with wrong contract_version
  // #when loadManifest is called
  // #then it returns ok: false with reason "manifest_schema_invalid"
  it("rejects manifest with wrong contract_version", async () => {
    const invalid = makeValidManifest({
      contract_version: "vector-runtime/v2" as never,
    })
    const filePath = trackTempDir(writeTempManifestJson(invalid))

    const result = await loadManifest(filePath)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("manifest_schema_invalid")
    }
  })
})

// ── validateManifestForSource ─────────────────────────────────────────

describe("validateManifestForSource", () => {
  // #given a valid manifest and a known source namespace
  // #when validateManifestForSource is called
  // #then it returns valid: true with no errors
  it("validates a known source namespace successfully", () => {
    const manifest = makeValidManifest()
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  // #given a valid manifest and source "all"
  // #when validateManifestForSource is called
  // #then it returns valid: true without requiring a specific source namespace
  it("accepts source 'all' without requiring a specific namespace", () => {
    const manifest = makeValidManifest()
    const result = validateManifestForSource(manifest, "all")

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  // #given a valid manifest and a missing source namespace
  // #when validateManifestForSource is called
  // #then it returns valid: false with a missing source error
  it("rejects a missing source namespace", () => {
    const manifest = makeValidManifest()
    const result = validateManifestForSource(manifest, "facts")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'source namespace "facts" not found in manifest sources',
    )
  })

  // #given a valid manifest and env with matching backend
  // #when validateManifestForSource is called with env
  // #then it returns valid: true
  it("accepts matching backend between manifest and env", () => {
    const manifest = makeValidManifest({ backend: "lancedb" })
    const env = makeEnv({ backend: "lancedb" })
    const result = validateManifestForSource(manifest, "opencode", env)

    expect(result.valid).toBe(true)
  })

  // #given a manifest with lancedb backend and env with qdrant backend
  // #when validateManifestForSource is called with env
  // #then it returns valid: false with backend mismatch error
  it("rejects backend mismatch between manifest and env", () => {
    const manifest = makeValidManifest({ backend: "lancedb" })
    const env = makeEnv({ backend: "qdrant" })
    const result = validateManifestForSource(manifest, "opencode", env)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'manifest backend "lancedb" does not match resolved backend "qdrant"',
    )
  })

  // #given a manifest with missing embedding model
  // #when validateManifestForSource is called
  // #then it returns valid: false with embedding model error
  it("rejects manifest with missing embedding model", () => {
    const manifest = makeValidManifest()
    manifest.embedding.model = ""
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      "manifest embedding model is missing or empty",
    )
  })

  // #given a manifest with invalid embedding dimensions
  // #when validateManifestForSource is called
  // #then it returns valid: false with dimensions error
  it("rejects manifest with zero embedding dimensions", () => {
    const manifest = makeValidManifest()
    manifest.embedding.dimensions = 0
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      "manifest embedding dimensions is invalid: 0",
    )
  })

  // #given a manifest with negative embedding dimensions
  // #when validateManifestForSource is called
  // #then it returns valid: false with dimensions error
  it("rejects manifest with negative embedding dimensions", () => {
    const manifest = makeValidManifest()
    manifest.embedding.dimensions = -1
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      "manifest embedding dimensions is invalid: -1",
    )
  })

  // #given a manifest with non-integer embedding dimensions
  // #when validateManifestForSource is called
  // #then it returns valid: false with dimensions error
  it("rejects manifest with non-integer embedding dimensions", () => {
    const manifest = makeValidManifest()
    manifest.embedding.dimensions = 3.14
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      "manifest embedding dimensions is invalid: 3.14",
    )
  })

  // #given a manifest with wrong contract_version
  // #when validateManifestForSource is called
  // #then it returns valid: false with contract version error
  it("rejects manifest with unsupported contract version", () => {
    const manifest = makeValidManifest({
      contract_version: "vector-runtime/v0" as never,
    })
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'unsupported contract version: vector-runtime/v0, expected "vector-runtime/v1"',
    )
  })

  // #given a manifest with a source entry missing table
  // #when validateManifestForSource is called
  // #then it returns valid: false with missing table error
  it("rejects source entry with empty table", () => {
    const manifest = makeValidManifest()
    manifest.sources.opencode.table = ""
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'source "opencode" table is missing or empty',
    )
  })

  // #given a manifest with a source entry missing schema_version
  // #when validateManifestForSource is called
  // #then it returns valid: false with missing schema_version error
  it("rejects source entry with empty schema_version", () => {
    const manifest = makeValidManifest()
    manifest.sources.opencode.schema_version = ""
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'source "opencode" schema_version is missing or empty',
    )
  })

  // #given a manifest with a source entry missing source_of_truth
  // #when validateManifestForSource is called
  // #then it returns valid: false with missing source_of_truth error
  it("rejects source entry with empty source_of_truth", () => {
    const manifest = makeValidManifest()
    manifest.sources.opencode.source_of_truth = ""
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'source "opencode" source_of_truth is missing or empty',
    )
  })

  // #given a manifest with a stale last_indexed_at (>24 hours ago)
  // #when validateManifestForSource is called
  // #then it returns valid: true with a staleness warning
  it("warns when source last_indexed_at is older than 24 hours", () => {
    const manifest = makeValidManifest()
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000) // 25 hours ago
    manifest.sources.opencode.last_indexed_at = staleDate.toISOString()
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain("may be stale")
  })

  // #given a manifest with a recent last_indexed_at (<24 hours ago)
  // #when validateManifestForSource is called
  // #then it returns valid: true with no staleness warning
  it("does not warn when source last_indexed_at is recent", () => {
    const manifest = makeValidManifest()
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000) // 1 hour ago
    manifest.sources.opencode.last_indexed_at = recentDate.toISOString()
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([])
  })

  // #given a manifest with an invalid last_indexed_at format
  // #when validateManifestForSource is called
  // #then it returns valid: true with a parse warning
  it("warns when last_indexed_at is not a valid ISO-8601 timestamp", () => {
    const manifest = makeValidManifest()
    manifest.sources.opencode.last_indexed_at = "not-a-date"
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain("not a valid ISO-8601 timestamp")
  })

  // #given a valid manifest without env
  // #when validateManifestForSource is called without env
  // #then it skips backend compatibility check
  it("skips backend check when env is not provided", () => {
    const manifest = makeValidManifest({ backend: "qdrant" })
    const result = validateManifestForSource(manifest, "opencode")

    expect(result.valid).toBe(true)
  })

  // #given a valid manifest and source "all" with env backend mismatch
  // #when validateManifestForSource is called
  // #then it still reports backend mismatch error
  it("reports backend mismatch even for source 'all'", () => {
    const manifest = makeValidManifest({ backend: "lancedb" })
    const env = makeEnv({ backend: "qdrant" })
    const result = validateManifestForSource(manifest, "all", env)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'manifest backend "lancedb" does not match resolved backend "qdrant"',
    )
  })

  // #given a valid manifest with multiple validation issues
  // #when validateManifestForSource is called
  // #then it collects all errors
  it("collects multiple validation errors", () => {
    const manifest = makeValidManifest()
    manifest.embedding.model = ""
    manifest.embedding.dimensions = 0
    const env = makeEnv({ backend: "qdrant" })
    const result = validateManifestForSource(manifest, "opencode", env)

    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  // #given a valid manifest with source "all"
  // #when validateManifestForSource is called
  // #then it does not check for specific source namespace existence
  it("does not require specific namespace for source 'all'", () => {
    const manifest = makeValidManifest()
    const opencodeSource = manifest.sources.opencode
    manifest.sources = { opencode: opencodeSource }

    const result = validateManifestForSource(manifest, "all")

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })
})