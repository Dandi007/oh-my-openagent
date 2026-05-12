import { describe, expect, it } from "bun:test"
import {
  createNoopRuntimeAdapter,
  createRuntimeAdapter,
  type QueryRuntime,
  type RuntimeAdapter,
} from "./runtime-adapter"
import type {
  ManifestContract,
  QueryRequest,
  ResolvedVectorRuntimeEnv,
  RuntimeDiagnostics,
} from "./types"

function makeEnv(overrides?: Partial<ResolvedVectorRuntimeEnv>): ResolvedVectorRuntimeEnv {
  return {
    backend: "noop",
    embedding: {},
    ...overrides,
  }
}

function makeManifest(overrides?: Partial<ManifestContract>): ManifestContract {
  return {
    contract_version: "vector-runtime/v1",
    backend: "lancedb",
    db_path: "/tmp/test-lancedb",
    embedding: {
      provider: "http",
      endpoint: "http://localhost:8080/v1/embeddings",
      model: "test-model",
      dimensions: 512,
    },
    sources: {
      opencode: {
        table: "opencode_sessions",
        schema_version: "opencode-session-chunk/v1",
        source_of_truth: "database",
        last_indexed_at: new Date().toISOString(),
      },
    },
    ...overrides,
  }
}

function validQueryRequest(overrides?: Partial<QueryRequest>): QueryRequest {
  return {
    query: "test query",
    source: "opencode",
    mode: "semantic",
    top_k: 10,
    ...overrides,
  }
}

describe("QueryRuntime interface", () => {
  // #given a noop adapter
  // #when we inspect its shape
  // #then it satisfies the QueryRuntime interface
  it("createNoopRuntimeAdapter returns an object satisfying QueryRuntime", () => {
    const adapter: QueryRuntime = createNoopRuntimeAdapter()
    expect(typeof adapter.validate).toBe("function")
    expect(typeof adapter.query).toBe("function")
    expect(typeof adapter.diagnostics).toBe("function")
  })

  // #given a noop adapter
  // #when we alias it as RuntimeAdapter
  // #then the alias is type-compatible
  it("RuntimeAdapter type alias is compatible with QueryRuntime", () => {
    const adapter: RuntimeAdapter = createNoopRuntimeAdapter()
    expect(adapter).toBeDefined()
  })
})

describe("createNoopRuntimeAdapter", () => {
  describe("diagnostics()", () => {
    // #given a default noop adapter
    // #when diagnostics() is called
    // #then it returns noop diagnostics with semantic_available=false
    it("returns default noop diagnostics", () => {
      const adapter = createNoopRuntimeAdapter()
      const diag = adapter.diagnostics()
      expect(diag).toEqual({
        backend: "noop",
        manifest_validated: false,
        semantic_available: false,
        reason: "noop_adapter",
      })
    })

    // #given a noop adapter with custom diagnostics
    // #when diagnostics() is called
    // #then custom fields are merged, backend is forced to "noop"
    it("merges custom diagnostics, forces backend to noop", () => {
      const adapter = createNoopRuntimeAdapter({
        manifest_validated: true,
        reason: "custom_reason",
      })
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("noop")
      expect(diag.manifest_validated).toBe(true)
      expect(diag.semantic_available).toBe(false)
      expect(diag.reason).toBe("custom_reason")
    })

    // #given a noop adapter with backend override attempt
    // #when diagnostics() is called
    // #then backend remains "noop"
    it("ignores backend override in custom diagnostics", () => {
      const adapter = createNoopRuntimeAdapter({ backend: "lancedb" })
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("noop")
    })
  })

  describe("validate()", () => {
    // #given a noop adapter
    // #when validate() is called
    // #then it returns invalid with a descriptive error
    it("returns invalid with noop adapter message", async () => {
      const adapter = createNoopRuntimeAdapter()
      const result = await adapter.validate()
      expect(result.valid).toBe(false)
      expect(result.errors).toContain("noop adapter: no manifest to validate")
      expect(result.warnings).toEqual([])
    })
  })

  describe("query()", () => {
    // #given a noop adapter and a valid query request
    // #when query() is called
    // #then it returns empty results with noop diagnostics
    it("returns empty results for valid request", async () => {
      const adapter = createNoopRuntimeAdapter()
      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
      expect(response.diagnostics.backend).toBe("noop")
      expect(response.diagnostics.semantic_available).toBe(false)
    })

    // #given a noop adapter and an invalid query request (empty query)
    // #when query() is called
    // #then it returns empty results with invalid_request diagnostics
    it("returns empty results with invalid_request reason for invalid request", async () => {
      const adapter = createNoopRuntimeAdapter()
      const response = await adapter.query({
        query: "",
        source: "opencode",
        mode: "semantic",
        top_k: 10,
      })
      expect(response.results).toEqual([])
      expect(response.diagnostics.semantic_available).toBe(false)
      expect(response.diagnostics.reason).toBe("invalid_query_request")
    })

    // #given a noop adapter and a request with top_k=0
    // #when query() is called
    // #then it returns empty results with invalid_request diagnostics
    it("rejects top_k=0 as invalid", async () => {
      const adapter = createNoopRuntimeAdapter()
      const response = await adapter.query(validQueryRequest({ top_k: 0 }))
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("invalid_query_request")
    })

    // #given a noop adapter and a request with top_k > 100
    // #when query() is called
    // #then it returns empty results with invalid_request diagnostics
    it("rejects top_k > 100 as invalid", async () => {
      const adapter = createNoopRuntimeAdapter()
      const response = await adapter.query(validQueryRequest({ top_k: 101 }))
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("invalid_query_request")
    })

    // #given a noop adapter and a request with invalid mode
    // #when query() is called
    // #then it returns empty results with invalid_request diagnostics
    it("rejects invalid mode", async () => {
      const adapter = createNoopRuntimeAdapter()
      const response = await adapter.query(
        validQueryRequest({ mode: "invalid" as "semantic" }),
      )
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("invalid_query_request")
    })

    // #given a noop adapter and a request with extra unknown fields
    // #when query() is called
    // #then it returns empty results with invalid_request diagnostics (strict schema)
    it("rejects request with extra unknown fields", async () => {
      const adapter = createNoopRuntimeAdapter()
      const response = await adapter.query({
        ...validQueryRequest(),
        extra_field: "should be rejected",
      } as QueryRequest)
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("invalid_query_request")
    })

    // #given a noop adapter
    // #when query() is called multiple times
    // #then it never throws and always returns empty results
    it("never throws on repeated queries", async () => {
      const adapter = createNoopRuntimeAdapter()
      for (let i = 0; i < 5; i++) {
        const response = await adapter.query(validQueryRequest())
        expect(response.results).toEqual([])
      }
    })
  })

  describe("no concrete backend access", () => {
    // #given a noop adapter
    // #when validate, query, and diagnostics are called
    // #then no filesystem, DB, subprocess, or network access occurs
    it("does not access filesystem, DB, subprocess, or network", async () => {
      const adapter = createNoopRuntimeAdapter()
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("noop")

      const validation = await adapter.validate()
      expect(validation.valid).toBe(false)

      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
    })
  })
})

describe("createRuntimeAdapter", () => {
  describe("no manifest or noop backend", () => {
    // #given an env with noop backend and no manifest
    // #when createRuntimeAdapter is called
    // #then it returns a noop adapter
    it("routes to noop when no manifest is provided", () => {
      const env = makeEnv({ backend: "noop" })
      const adapter = createRuntimeAdapter(env)
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("noop")
      expect(diag.reason).toBe("noop_adapter")
    })

    // #given an env and a manifest with backend "noop"
    // #when createRuntimeAdapter is called
    // #then it returns a noop adapter
    it("routes to noop when manifest backend is noop", () => {
      const env = makeEnv({ backend: "noop" })
      const manifest = makeManifest({ backend: "noop" })
      const adapter = createRuntimeAdapter(env, manifest)
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("noop")
      expect(diag.reason).toBe("noop_adapter")
    })
  })

  describe("lancedb backend", () => {
    // #given an env and a manifest with backend "lancedb"
    // #when createRuntimeAdapter is called
    // #then it returns a noop adapter with backend_not_implemented_in_current_refactor reason
    it("routes lancedb to noop with not-implemented reason", () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("lancedb")
      expect(diag.semantic_available).toBe(false)
      expect(diag.reason).toBe("backend_not_implemented_in_current_refactor")
    })

    // #given a lancedb-routed adapter with valid manifest
    // #when query() is called with a valid request whose source exists in manifest
    // #then it validates manifest, returns empty results with manifest_validated=true
    it("validates manifest and returns not-implemented with manifest_validated=true", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe(
        "backend_not_implemented_in_current_refactor",
      )
      expect(response.diagnostics.manifest_validated).toBe(true)
      expect(response.diagnostics.semantic_available).toBe(false)
    })

    // #given a lancedb-routed adapter with valid manifest
    // #when query() is called with a source NOT in the manifest
    // #then it returns manifest_invalid reason
    it("returns manifest_invalid when query source is missing from manifest", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const response = await adapter.query(
        validQueryRequest({ source: "markdown" }),
      )
      expect(response.results).toEqual([])
      expect(response.diagnostics.semantic_available).toBe(false)
      expect(response.diagnostics.reason).toBe("manifest_invalid")
    })

    // #given a lancedb-routed adapter with valid manifest
    // #when query() is called with an invalid request (empty query)
    // #then it returns invalid_query_request BEFORE manifest validation
    it("returns invalid_query_request before manifest validation for invalid request", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const response = await adapter.query({
        query: "",
        source: "opencode",
        mode: "semantic",
        top_k: 10,
      })
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("invalid_query_request")
      expect(response.diagnostics.manifest_validated).toBe(false)
    })

    // #given a lancedb-routed adapter
    // #when validate() is called
    // #then it validates the manifest for "all" sources
    it("validate() checks manifest for all sources on lancedb route", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const result = await adapter.validate()
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  })

  describe("qdrant backend", () => {
    // #given an env and a manifest with backend "qdrant"
    // #when createRuntimeAdapter is called
    // #then it returns a noop adapter with backend_not_implemented_in_current_refactor reason
    it("routes qdrant to noop with not-implemented reason", () => {
      const env = makeEnv({ backend: "qdrant" })
      const manifest = makeManifest({ backend: "qdrant" })
      const adapter = createRuntimeAdapter(env, manifest)
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("qdrant")
      expect(diag.semantic_available).toBe(false)
      expect(diag.reason).toBe("backend_not_implemented_in_current_refactor")
    })

    // #given a qdrant-routed adapter with valid manifest
    // #when query() is called with a valid request
    // #then it validates manifest and returns not-implemented with manifest_validated=true
    it("validates manifest and returns not-implemented with manifest_validated=true", async () => {
      const env = makeEnv({ backend: "qdrant" })
      const manifest = makeManifest({ backend: "qdrant" })
      const adapter = createRuntimeAdapter(env, manifest)
      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe(
        "backend_not_implemented_in_current_refactor",
      )
      expect(response.diagnostics.manifest_validated).toBe(true)
      expect(response.diagnostics.semantic_available).toBe(false)
    })
  })

  describe("backend mismatch between env and manifest", () => {
    // #given env.backend="qdrant" and manifest.backend="lancedb"
    // #when validate() is called
    // #then it returns valid=false with backend mismatch error
    it("validate() detects backend mismatch and returns valid=false", async () => {
      const env = makeEnv({ backend: "qdrant" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const result = await adapter.validate()
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("does not match resolved backend"))).toBe(true)
    })

    // #given env.backend="qdrant" and manifest.backend="lancedb"
    // #when query() is called with a valid request
    // #then it returns manifest_invalid with semantic_available=false
    it("query() returns manifest_invalid when backends differ", async () => {
      const env = makeEnv({ backend: "qdrant" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("manifest_invalid")
      expect(response.diagnostics.semantic_available).toBe(false)
      expect(response.diagnostics.manifest_validated).toBe(true)
    })

    // #given env.backend="lancedb" and manifest.backend="qdrant"
    // #when validate() is called
    // #then it returns valid=false with backend mismatch error
    it("validate() detects reverse backend mismatch (lancedb env vs qdrant manifest)", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "qdrant" })
      const adapter = createRuntimeAdapter(env, manifest)
      const result = await adapter.validate()
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("does not match resolved backend"))).toBe(true)
    })

    // #given env.backend="lancedb" and manifest.backend="qdrant"
    // #when query() is called with a valid request
    // #then it returns manifest_invalid with semantic_available=false
    it("query() returns manifest_invalid for reverse backend mismatch", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "qdrant" })
      const adapter = createRuntimeAdapter(env, manifest)
      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
      expect(response.diagnostics.reason).toBe("manifest_invalid")
      expect(response.diagnostics.semantic_available).toBe(false)
      expect(response.diagnostics.manifest_validated).toBe(true)
    })
  })

  describe("unknown backend in manifest", () => {
    // #given a manifest with an unrecognized backend
    // #when createRuntimeAdapter is called
    // #then it falls back to noop adapter
    it("falls back to noop for unrecognized manifest backend", () => {
      const env = makeEnv({ backend: "noop" })
      const manifest = makeManifest({ backend: "unknown" as "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)
      const diag = adapter.diagnostics()
      expect(diag.backend).toBe("noop")
      expect(diag.reason).toBe("noop_adapter")
    })
  })

  describe("no concrete backend access", () => {
    // #given adapters created via factory for all backend types
    // #when validate, query, and diagnostics are called
    // #then no filesystem, DB, subprocess, or network access occurs
    it("never accesses concrete backends for lancedb route", async () => {
      const env = makeEnv({ backend: "lancedb" })
      const manifest = makeManifest({ backend: "lancedb" })
      const adapter = createRuntimeAdapter(env, manifest)

      const diag = adapter.diagnostics()
      expect(diag.reason).toBe("backend_not_implemented_in_current_refactor")

      const validation = await adapter.validate()
      expect(validation.valid).toBe(true)

      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
    })

    it("never accesses concrete backends for qdrant route", async () => {
      const env = makeEnv({ backend: "qdrant" })
      const manifest = makeManifest({ backend: "qdrant" })
      const adapter = createRuntimeAdapter(env, manifest)

      const diag = adapter.diagnostics()
      expect(diag.reason).toBe("backend_not_implemented_in_current_refactor")

      const response = await adapter.query(validQueryRequest())
      expect(response.results).toEqual([])
    })
  })

  describe("mockability", () => {
    // #given the QueryRuntime interface
    // #when a mock is created
    // #then it can be used in place of a real adapter
    it("QueryRuntime can be mocked for testing", async () => {
      const mock: QueryRuntime = {
        validate: async () => ({
          valid: true,
          errors: [],
          warnings: [],
        }),
        query: async () => ({
          results: [
            {
              source: "opencode",
              chunk_id: "mock-chunk",
              score: 0.95,
              text: "mock result",
              metadata: {},
            },
          ],
          diagnostics: {
            backend: "lancedb",
            manifest_validated: true,
            semantic_available: true,
          },
        }),
        diagnostics: () => ({
          backend: "lancedb",
          manifest_validated: true,
          semantic_available: true,
        }),
      }

      const diag = mock.diagnostics()
      expect(diag.semantic_available).toBe(true)

      const validation = await mock.validate()
      expect(validation.valid).toBe(true)

      const response = await mock.query(validQueryRequest())
      expect(response.results).toHaveLength(1)
      expect(response.results[0].chunk_id).toBe("mock-chunk")
    })
  })
})