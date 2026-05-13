import { describe, expect, test } from "bun:test"
import { resolveVectorRuntimeEnv } from "./env"
import { resolveVectorConfig } from "./paths"
import type { EnvResolutionResult } from "./env"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── Helpers ───────────────────────────────────────────────────────────

function resolve(input: Record<string, string | undefined>): EnvResolutionResult {
  return resolveVectorRuntimeEnv(input)
}

// ── Empty / missing input ─────────────────────────────────────────────

describe("resolveVectorRuntimeEnv — empty input", () => {
  test("empty object resolves to noop backend with vector_config_missing diagnostic", () => {
    // #given an empty env map
    // #when resolving
    const result = resolve({})
    // #then backend is noop and vector_config_missing diagnostic is emitted
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
    expect(result.diagnostics[0]).toContain("semantic search is unavailable")
  })

  test("all optional fields are undefined with empty input", () => {
    // #given an empty env map
    // #when resolving
    const result = resolve({})
    // #then every optional field is undefined
    expect(result.env.dbPath).toBeUndefined()
    expect(result.env.dbUri).toBeUndefined()
    expect(result.env.manifestPath).toBeUndefined()
    expect(result.env.embedding.endpoint).toBeUndefined()
    expect(result.env.embedding.model).toBeUndefined()
    expect(result.env.embedding.dimensions).toBeUndefined()
    expect(result.env.timeoutMs).toBeUndefined()
    // #and vector_config_missing diagnostic is present
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
  })

  test("omitting input falls back to process.env without throwing", () => {
    // #given no input argument
    // #when resolving (should not throw)
    // #then a result is returned (exact values depend on host env)
    const result = resolveVectorRuntimeEnv()
    expect(result.env).toBeDefined()
    expect(result.env.backend).toBeDefined()
    expect(Array.isArray(result.diagnostics)).toBe(true)
  })
})

// ── Backend resolution ────────────────────────────────────────────────

describe("resolveVectorRuntimeEnv — backend", () => {
  test('resolves "lancedb" backend', () => {
    // #given AGENT_VECTOR_DB_BACKEND=lancedb
    // #when resolving
    const result = resolve({ AGENT_VECTOR_DB_BACKEND: "lancedb" })
    // #then backend is lancedb with no diagnostics
    expect(result.env.backend).toBe("lancedb")
    expect(result.diagnostics).toEqual([])
  })

  test('resolves "qdrant" backend', () => {
    // #given AGENT_VECTOR_DB_BACKEND=qdrant
    // #when resolving
    const result = resolve({ AGENT_VECTOR_DB_BACKEND: "qdrant" })
    // #then backend is qdrant with no diagnostics
    expect(result.env.backend).toBe("qdrant")
    expect(result.diagnostics).toEqual([])
  })

  test('resolves "noop" backend explicitly', () => {
    // #given AGENT_VECTOR_DB_BACKEND=noop
    // #when resolving
    const result = resolve({ AGENT_VECTOR_DB_BACKEND: "noop" })
    // #then backend is noop with no diagnostics
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics).toEqual([])
  })

  test("unknown backend falls back to noop with diagnostic", () => {
    // #given an unsupported backend value
    // #when resolving
    const result = resolve({ AGENT_VECTOR_DB_BACKEND: "pinecone" })
    // #then backend is noop and a diagnostic is emitted
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]).toContain("pinecone")
    expect(result.diagnostics[0]).toContain("noop")
  })

  test("empty string backend treated as unset with vector_config_missing", () => {
    // #given an empty AGENT_VECTOR_DB_BACKEND
    // #when resolving
    const result = resolve({ AGENT_VECTOR_DB_BACKEND: "" })
    // #then backend defaults to noop with vector_config_missing diagnostic
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
  })

  test("whitespace-only backend treated as unset with vector_config_missing", () => {
    // #given a whitespace-only AGENT_VECTOR_DB_BACKEND
    // #when resolving
    const result = resolve({ AGENT_VECTOR_DB_BACKEND: "   " })
    // #then backend defaults to noop with vector_config_missing diagnostic
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
  })
})

// ── Full env mapping ──────────────────────────────────────────────────

describe("resolveVectorRuntimeEnv — full mapping", () => {
  test("all known env vars are mapped correctly", () => {
    // #given a complete set of env contract variables (spec-approved only)
    const input: Record<string, string | undefined> = {
      AGENT_VECTOR_DB_BACKEND: "lancedb",
      AGENT_VECTOR_DB_PATH: "/tmp/lancedb",
      AGENT_VECTOR_DB_URI: "http://localhost:6333",
      AGENT_VECTOR_MANIFEST: "/tmp/manifest.json",
      AGENT_EMBEDDING_ENDPOINT: "http://localhost:8080/v1/embeddings",
      AGENT_EMBEDDING_MODEL: "BAAI/bge-small-zh-v1.5",
      AGENT_EMBEDDING_DIMENSIONS: "512",
      AGENT_VECTOR_TIMEOUT_MS: "30000",
    }
    // #when resolving
    const result = resolve(input)
    // #then every field is mapped correctly
    expect(result.env.backend).toBe("lancedb")
    expect(result.env.dbPath).toBe("/tmp/lancedb")
    expect(result.env.dbUri).toBe("http://localhost:6333")
    expect(result.env.manifestPath).toBe("/tmp/manifest.json")
    expect(result.env.embedding.endpoint).toBe("http://localhost:8080/v1/embeddings")
    expect(result.env.embedding.model).toBe("BAAI/bge-small-zh-v1.5")
    expect(result.env.embedding.dimensions).toBe(512)
    expect(result.env.timeoutMs).toBe(30000)
    expect(result.diagnostics).toEqual([])
  })
})

// ── API key exclusion ─────────────────────────────────────────────────

describe("resolveVectorRuntimeEnv — API key exclusion", () => {
  test("AGENT_VECTOR_DB_API_KEY is not exposed in returned env", () => {
    // #given an env map with a DB API key
    const input: Record<string, string | undefined> = {
      AGENT_VECTOR_DB_API_KEY: "secret-db-key-12345",
      AGENT_VECTOR_DB_BACKEND: "qdrant",
    }
    // #when resolving
    const result = resolve(input)
    // #then the API key does NOT appear anywhere in the result
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("secret-db-key-12345")
  })

  test("AGENT_EMBEDDING_API_KEY is not exposed in returned env", () => {
    // #given an env map with an embedding API key
    const input: Record<string, string | undefined> = {
      AGENT_EMBEDDING_API_KEY: "secret-embed-key-67890",
      AGENT_EMBEDDING_ENDPOINT: "http://localhost:8080",
    }
    // #when resolving
    const result = resolve(input)
    // #then the API key does NOT appear anywhere in the result
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("secret-embed-key-67890")
  })

  test("both API keys are excluded simultaneously", () => {
    // #given an env map with both API keys
    const input: Record<string, string | undefined> = {
      AGENT_VECTOR_DB_API_KEY: "db-secret",
      AGENT_EMBEDDING_API_KEY: "embed-secret",
      AGENT_VECTOR_DB_BACKEND: "lancedb",
      AGENT_EMBEDDING_ENDPOINT: "http://localhost:8080",
    }
    // #when resolving
    const result = resolve(input)
    // #then neither key appears in the serialized result
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("db-secret")
    expect(serialized).not.toContain("embed-secret")
    // #and the non-secret fields are still resolved
    expect(result.env.backend).toBe("lancedb")
    expect(result.env.embedding.endpoint).toBe("http://localhost:8080")
  })
})

// ── Numeric validation ────────────────────────────────────────────────

describe("resolveVectorRuntimeEnv — numeric validation", () => {
  test("valid dimensions string is parsed to number", () => {
    // #given a valid dimensions value
    // #when resolving
    const result = resolve({ AGENT_EMBEDDING_DIMENSIONS: "768" })
    // #then dimensions is a number with no diagnostics
    expect(result.env.embedding.dimensions).toBe(768)
    expect(result.diagnostics).toEqual([])
  })

  test("non-numeric dimensions produces diagnostic and undefined", () => {
    // #given a non-numeric dimensions value
    // #when resolving
    const result = resolve({ AGENT_EMBEDDING_DIMENSIONS: "abc" })
    // #then dimensions is undefined and a diagnostic is emitted
    expect(result.env.embedding.dimensions).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]).toContain("AGENT_EMBEDDING_DIMENSIONS")
    expect(result.diagnostics[0]).toContain("positive integer")
  })

  test("negative dimensions produces diagnostic and undefined", () => {
    // #given a negative dimensions value
    // #when resolving
    const result = resolve({ AGENT_EMBEDDING_DIMENSIONS: "-1" })
    // #then dimensions is undefined and a diagnostic is emitted
    expect(result.env.embedding.dimensions).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]).toContain("AGENT_EMBEDDING_DIMENSIONS")
  })

  test("zero dimensions produces diagnostic and undefined", () => {
    // #given a zero dimensions value
    // #when resolving
    const result = resolve({ AGENT_EMBEDDING_DIMENSIONS: "0" })
    // #then dimensions is undefined and a diagnostic is emitted
    expect(result.env.embedding.dimensions).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
  })

  test("float dimensions produces diagnostic and undefined", () => {
    // #given a float dimensions value
    // #when resolving
    const result = resolve({ AGENT_EMBEDDING_DIMENSIONS: "512.5" })
    // #then dimensions is undefined and a diagnostic is emitted
    expect(result.env.embedding.dimensions).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
  })

  test("valid timeout is parsed to number", () => {
    // #given a valid timeout value
    // #when resolving
    const result = resolve({ AGENT_VECTOR_TIMEOUT_MS: "15000" })
    // #then timeoutMs is a number with no diagnostics
    expect(result.env.timeoutMs).toBe(15000)
    expect(result.diagnostics).toEqual([])
  })

  test("non-numeric timeout produces diagnostic and undefined", () => {
    // #given a non-numeric timeout value
    // #when resolving
    const result = resolve({ AGENT_VECTOR_TIMEOUT_MS: "fast" })
    // #then timeoutMs is undefined and a diagnostic is emitted
    expect(result.env.timeoutMs).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
    expect(result.diagnostics[0]).toContain("AGENT_VECTOR_TIMEOUT_MS")
    expect(result.diagnostics[0]).toContain("positive integer")
  })

  test("zero timeout produces diagnostic and undefined", () => {
    // #given a zero timeout value
    // #when resolving
    const result = resolve({ AGENT_VECTOR_TIMEOUT_MS: "0" })
    // #then timeoutMs is undefined and a diagnostic is emitted
    expect(result.env.timeoutMs).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
  })

  test("negative timeout produces diagnostic and undefined", () => {
    // #given a negative timeout value
    // #when resolving
    const result = resolve({ AGENT_VECTOR_TIMEOUT_MS: "-500" })
    // #then timeoutMs is undefined and a diagnostic is emitted
    expect(result.env.timeoutMs).toBeUndefined()
    expect(result.diagnostics.length).toBe(1)
  })

  test("multiple invalid numerics accumulate diagnostics", () => {
    // #given both dimensions and timeout are invalid
    // #when resolving
    const result = resolve({
      AGENT_EMBEDDING_DIMENSIONS: "bad",
      AGENT_VECTOR_TIMEOUT_MS: "also-bad",
    })
    // #then both are undefined and two diagnostics are emitted
    expect(result.env.embedding.dimensions).toBeUndefined()
    expect(result.env.timeoutMs).toBeUndefined()
    expect(result.diagnostics.length).toBe(2)
  })
})

// ── Edge cases ────────────────────────────────────────────────────────

describe("resolveVectorRuntimeEnv — edge cases", () => {
  test("whitespace is trimmed from string values", () => {
    // #given env vars with leading/trailing whitespace
    // #when resolving
    const result = resolve({
      AGENT_VECTOR_DB_PATH: "\t/path/to/db\n",
    })
    // #then values are trimmed
    expect(result.env.dbPath).toBe("/path/to/db")
  })

  test("empty string values are treated as unset with vector_config_missing", () => {
    // #given env vars set to empty strings
    // #when resolving
    const result = resolve({
      AGENT_VECTOR_DB_PATH: "",
      AGENT_VECTOR_MANIFEST: "",
    })
    // #then all are undefined
    expect(result.env.dbPath).toBeUndefined()
    expect(result.env.manifestPath).toBeUndefined()
    // #and vector_config_missing diagnostic is emitted
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
  })

  test("no hard-coded home or iCloud paths are invented", () => {
    // #given an empty env map
    // #when resolving
    const result = resolve({})
    const serialized = JSON.stringify(result)
    // #then no hard-coded paths appear
    expect(serialized).not.toContain("/Users/uther")
    expect(serialized).not.toContain("iCloud")
    expect(serialized).not.toContain("~/.cache")
  })

  test("result is always structurally valid", () => {
    // #given various invalid inputs
    // #when resolving
    const result = resolve({
      AGENT_VECTOR_DB_BACKEND: "invalid",
      AGENT_EMBEDDING_DIMENSIONS: "NaN",
      AGENT_VECTOR_TIMEOUT_MS: "Infinity",
    })
    // #then the env object is always present with a valid backend
    expect(result.env).toBeDefined()
    expect(result.env.backend).toBe("noop")
    expect(result.env.embedding).toBeDefined()
    expect(Array.isArray(result.diagnostics)).toBe(true)
    expect(result.diagnostics.length).toBeGreaterThan(0)
  })

  test("AGENT_KNOWLEDGE_ROOT is ignored and does not suppress vector_config_missing", () => {
    // #given only the removed AGENT_KNOWLEDGE_ROOT env var
    // #when resolving
    const result = resolve({ AGENT_KNOWLEDGE_ROOT: "/tmp/should-not-be-used" })
    // #then knowledgeRoot is NOT populated in returned env
    const serialized = JSON.stringify(result.env)
    expect(serialized).not.toContain("should-not-be-used")
    // #and vector_config_missing is still emitted (not suppressed)
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
  })

  test("AGENT_VECTOR_SOURCE is ignored and does not suppress vector_config_missing", () => {
    // #given only the removed AGENT_VECTOR_SOURCE env var
    // #when resolving
    const result = resolve({ AGENT_VECTOR_SOURCE: "markdown" })
    // #then source is NOT populated in returned env
    const serialized = JSON.stringify(result.env)
    expect(serialized).not.toContain("markdown")
    // #and vector_config_missing is still emitted (not suppressed)
    expect(result.env.backend).toBe("noop")
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toContain("vector_config_missing")
  })

  test("vector_config_missing diagnostic has expected shape", () => {
    // #given an empty env map
    // #when resolving
    const result = resolve({})
    // #then the diagnostic explicitly states semantic search is unavailable
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]).toBe(
      "vector_config_missing: no vector backend or embedding configuration detected; semantic search is unavailable",
    )
  })
})

// ── resolveVectorConfig tests ─────────────────────────────────────────

describe("resolveVectorConfig — path precedence", () => {
  test("explicit overrides win over env vars", () => {
    // #given explicit overrides and env vars both set
    const config = resolveVectorConfig(
      { indexPath: "/explicit/index", manifestPath: "/explicit/manifest.json" },
      {
        AGENT_VECTOR_DB_PATH: "/env/index",
        AGENT_VECTOR_MANIFEST: "/env/manifest.json",
      },
    )
    // #then explicit overrides are used
    expect(config.indexPath).toBe("/explicit/index")
    expect(config.manifestPath).toBe("/explicit/manifest.json")
  })

  test("env vars win over default cache paths", () => {
    // #given env vars set but no explicit overrides
    const xdgCacheHome = join(tmpdir(), `omo-env-test-cache-${Date.now()}`)
    const config = resolveVectorConfig(
      {},
      {
        XDG_CACHE_HOME: xdgCacheHome,
        AGENT_VECTOR_DB_PATH: "/env/index",
        AGENT_VECTOR_MANIFEST: "/env/manifest.json",
      },
    )
    // #then env vars are used, not defaults
    expect(config.indexPath).toBe("/env/index")
    expect(config.manifestPath).toBe("/env/manifest.json")
  })

  test("default cache paths are used when nothing is set", () => {
    // #given no overrides and no env vars
    const xdgCacheHome = join(tmpdir(), `omo-env-test-default-${Date.now()}`)
    const config = resolveVectorConfig(
      {},
      { XDG_CACHE_HOME: xdgCacheHome },
    )
    // #then default cache paths are used
    const expectedDir = join(xdgCacheHome, "oh-my-opencode", "vector")
    expect(config.indexPath).toBe(join(expectedDir, "opencode-sessions"))
    expect(config.manifestPath).toBe(join(expectedDir, "vector-manifest.json"))
  })

  test("explicit manifest override wins but indexPath falls back to env", () => {
    // #given only manifest override, env provides indexPath
    const config = resolveVectorConfig(
      { manifestPath: "/explicit/manifest.json" },
      { AGENT_VECTOR_DB_PATH: "/env/index" },
    )
    // #then manifest uses override, indexPath uses env
    expect(config.indexPath).toBe("/env/index")
    expect(config.manifestPath).toBe("/explicit/manifest.json")
  })

  test("explicit indexPath override wins but manifestPath falls back to env", () => {
    // #given only indexPath override, env provides manifestPath
    const config = resolveVectorConfig(
      { indexPath: "/explicit/index" },
      { AGENT_VECTOR_MANIFEST: "/env/manifest.json" },
    )
    // #then indexPath uses override, manifestPath uses env
    expect(config.indexPath).toBe("/explicit/index")
    expect(config.manifestPath).toBe("/env/manifest.json")
  })
})

describe("resolveVectorConfig — embedding and backend", () => {
  test("embedding config is propagated from env resolver", () => {
    // #given full embedding config in env
    const config = resolveVectorConfig(
      {},
      {
        AGENT_EMBEDDING_ENDPOINT: "http://localhost:8080/v1/embeddings",
        AGENT_EMBEDDING_MODEL: "test-model",
        AGENT_EMBEDDING_DIMENSIONS: "768",
      },
    )
    // #then embedding fields are resolved
    expect(config.embedding.endpoint).toBe("http://localhost:8080/v1/embeddings")
    expect(config.embedding.model).toBe("test-model")
    expect(config.embedding.dimensions).toBe(768)
  })

  test("backend is propagated from env resolver", () => {
    // #given lancedb backend in env
    const config = resolveVectorConfig(
      {},
      { AGENT_VECTOR_DB_BACKEND: "lancedb" },
    )
    // #then backend is lancedb
    expect(config.backend).toBe("lancedb")
  })

  test("timeoutMs is propagated from env resolver", () => {
    // #given timeout in env
    const config = resolveVectorConfig(
      {},
      { AGENT_VECTOR_TIMEOUT_MS: "15000" },
    )
    // #then timeoutMs is resolved
    expect(config.timeoutMs).toBe(15000)
  })
})

describe("resolveVectorConfig — secret safety", () => {
  test("API keys are not exposed in resolved config", () => {
    // #given env with API keys
    const config = resolveVectorConfig(
      {},
      {
        AGENT_VECTOR_DB_API_KEY: "secret-db-key",
        AGENT_EMBEDDING_API_KEY: "secret-embed-key",
        AGENT_VECTOR_DB_BACKEND: "lancedb",
        AGENT_EMBEDDING_ENDPOINT: "http://localhost:8080",
      },
    )
    // #then API keys are not in the serialized result
    const serialized = JSON.stringify(config)
    expect(serialized).not.toContain("secret-db-key")
    expect(serialized).not.toContain("secret-embed-key")
    // #and non-secret fields are still resolved
    expect(config.backend).toBe("lancedb")
    expect(config.embedding.endpoint).toBe("http://localhost:8080")
  })
})

describe("resolveVectorConfig — diagnostics", () => {
  test("diagnostics are propagated from env resolver", () => {
    // #given invalid backend
    const config = resolveVectorConfig(
      {},
      { AGENT_VECTOR_DB_BACKEND: "pinecone" },
    )
    // #then diagnostic is present
    expect(config.diagnostics.length).toBeGreaterThan(0)
    expect(config.diagnostics.some((d) => d.includes("pinecone"))).toBe(true)
  })

  test("vector_config_missing diagnostic is emitted when no config is set", () => {
    // #given empty env
    const config = resolveVectorConfig({}, {})
    // #then vector_config_missing diagnostic is present
    expect(config.diagnostics.length).toBeGreaterThan(0)
    expect(config.diagnostics.some((d) => d.includes("vector_config_missing"))).toBe(true)
  })
})

describe("resolveVectorConfig — createDirectories", () => {
  test("createDirectories: true creates the cache directory", () => {
    // #given a fresh XDG_CACHE_HOME
    const xdgCacheHome = join(tmpdir(), `omo-env-test-mkdir-${Date.now()}`)
    const expectedDir = join(xdgCacheHome, "oh-my-opencode", "vector")
    try {
      expect(existsSync(expectedDir)).toBe(false)
      // #when resolving with createDirectories: true
      resolveVectorConfig({}, { XDG_CACHE_HOME: xdgCacheHome }, { createDirectories: true })
      // #then the cache directory is created
      expect(existsSync(expectedDir)).toBe(true)
    } finally {
      rmSync(xdgCacheHome, { recursive: true, force: true })
    }
  })

  test("createDirectories: false does not create the cache directory", () => {
    // #given a fresh XDG_CACHE_HOME
    const xdgCacheHome = join(tmpdir(), `omo-env-test-nomkdir-${Date.now()}`)
    const expectedDir = join(xdgCacheHome, "oh-my-opencode", "vector")
    try {
      expect(existsSync(expectedDir)).toBe(false)
      // #when resolving without createDirectories
      resolveVectorConfig({}, { XDG_CACHE_HOME: xdgCacheHome })
      // #then the cache directory is NOT created
      expect(existsSync(expectedDir)).toBe(false)
    } finally {
      rmSync(xdgCacheHome, { recursive: true, force: true })
    }
  })
})