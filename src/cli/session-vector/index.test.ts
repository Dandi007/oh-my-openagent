import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { $ } from "bun"

const CLEANUP_PATHS: string[] = []

function tempPath(label: string, suffix: string): string {
  const path = join(
    tmpdir(),
    `omo-cli-vector-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  )
  CLEANUP_PATHS.push(path)
  return path
}

function checksum(path: string): { bytes: number; sha256: string } {
  const bytes = readFileSync(path)
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function createFixtureDb(label: string): string {
  const dbPath = tempPath(label, ".db")
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode=DELETE")
  db.run("PRAGMA foreign_keys=ON")

  db.run(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    )
  `)

  const now = 1_777_000_000_000
  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_cli", "proj_1", "cli-test", "/workspace/cli", "CLI build fixture", "1.0", now - 1000, now],
  )

  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "msg_cli_user",
      "ses_cli",
      now - 900,
      now - 850,
      JSON.stringify({ role: "user", text: "CLI test message content" }),
    ],
  )

  db.close()
  return dbPath
}

function createMultiSessionFixtureDb(label: string): string {
  const dbPath = tempPath(label, ".db")
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode=DELETE")
  db.run("PRAGMA foreign_keys=ON")

  db.run(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    )
  `)

  const now = 1_777_000_000_000

  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_aaa", "proj_1", "aaa", "/workspace/a", "Session AAA", "1.0", now - 2000, now - 1000],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_aaa_1", "ses_aaa", now - 1900, now - 1850, JSON.stringify({ role: "user", text: "AAA message one" })],
  )

  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_bbb", "proj_1", "bbb", "/workspace/b", "Session BBB", "1.0", now - 1500, now - 500],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_bbb_1", "ses_bbb", now - 1400, now - 1350, JSON.stringify({ role: "user", text: "BBB message one" })],
  )

  db.run(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["ses_ccc", "proj_1", "ccc", "/workspace/c", "Session CCC", "1.0", now - 1000, now],
  )
  db.run(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
    ["msg_ccc_1", "ses_ccc", now - 900, now - 850, JSON.stringify({ role: "user", text: "CCC message one" })],
  )

  db.close()
  return dbPath
}

let embeddingServer: ReturnType<typeof Bun.serve> | null = null
let embeddingPort = 0

function getEmbeddingEnv(): Record<string, string> {
  return {
    AGENT_EMBEDDING_ENDPOINT: `http://localhost:${embeddingPort}/v1/embeddings`,
    AGENT_EMBEDDING_MODEL: "test-model",
    AGENT_EMBEDDING_DIMENSIONS: "3",
    AGENT_EMBEDDING_API_KEY: "test-key",
  }
}

beforeAll(async () => {
  embeddingServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v1/embeddings" && req.method === "POST") {
        const body = await req.json() as { input: string[] }
        const embeddings = body.input.map(() => [0.1, 0.2, 0.3])
        return new Response(JSON.stringify({
          object: "list",
          data: embeddings.map((embedding, index) => ({
            object: "embedding",
            index,
            embedding,
          })),
          model: "test-model",
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }), {
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("Not Found", { status: 404 })
    },
  })
  const port = embeddingServer.port
  if (typeof port !== "number") throw new Error("embedding server port not available")
  embeddingPort = port
})

afterAll(() => {
  if (embeddingServer) {
    embeddingServer.stop()
  }
})

afterEach(() => {
  for (const path of CLEANUP_PATHS.splice(0)) {
    if (path.endsWith(".db") || path.endsWith(".json")) {
      if (existsSync(path)) unlinkSync(path)
    } else {
      rmSync(path, { recursive: true, force: true })
    }
  }
})

const CLI_ENTRY = join(import.meta.dir, "..", "index.ts")

describe("session-vector build CLI", () => {
  test("--help shows expected options", async () => {
    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build --help`.nothrow().quiet()
    const stdout = result.stdout.toString()
    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("--db")
    expect(stdout).toContain("--index")
    expect(stdout).toContain("--manifest")
    expect(stdout).toContain("--json")
  })

  test("builds vector index from fixture DB and reports stats", async () => {
    const sourceDbPath = createFixtureDb("cli-build")
    const before = checksum(sourceDbPath)
    const vectorDbPath = tempPath("cli-vector", "")
    const manifestPath = tempPath("cli-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --json`.env(getEmbeddingEnv()).nothrow().quiet()

    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()

    // Source DB must be unchanged
    const after = checksum(sourceDbPath)
    expect(after).toEqual(before)

    // Should succeed
    if (result.exitCode !== 0) {
      throw new Error(`CLI failed with exit ${result.exitCode}: ${stderr}`)
    }

    // Parse JSON output
    const output = JSON.parse(stdout)
    expect(output).toHaveProperty("chunks_indexed")
    expect(output.chunks_indexed).toBeGreaterThan(0)
    expect(output).toHaveProperty("source_namespace", "opencode")
    expect(output).toHaveProperty("manifest_path", manifestPath)
    expect(output).toHaveProperty("index_path", vectorDbPath)
    expect(output).toHaveProperty("indexed_at")
    expect(typeof output.indexed_at).toBe("string")

    // No credentials in output
    expect(stdout).not.toContain("test-key")
    expect(stdout).not.toContain("AGENT_EMBEDDING_API_KEY")

    // Manifest file should exist and be valid
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    expect(manifest.contract_version).toBe("vector-runtime/v1")
    expect(manifest.sources.opencode).toBeDefined()
  })

  test("fails with controlled error when embedding config is missing", async () => {
    const sourceDbPath = createFixtureDb("cli-no-embed")
    const vectorDbPath = tempPath("cli-no-embed-vector", "")
    const manifestPath = tempPath("cli-no-embed-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath}`.env({
      // No embedding config set
    }).nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    const stderr = result.stderr.toString()

    // Error message should be controlled, not leaking env
    expect(stderr).not.toContain("AGENT_EMBEDDING_API_KEY")
    expect(stderr).not.toContain("api_key")
    expect(stderr).not.toContain("Bearer")
  })

  test("--json output is machine-parseable and secret-safe", async () => {
    const sourceDbPath = createFixtureDb("cli-json")
    const vectorDbPath = tempPath("cli-json-vector", "")
    const manifestPath = tempPath("cli-json-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --json`.env({
      ...getEmbeddingEnv(),
      AGENT_EMBEDDING_API_KEY: "secret-should-not-leak",
    }).nothrow().quiet()

    if (result.exitCode !== 0) {
      throw new Error(`CLI failed: ${result.stderr.toString()}`)
    }

    const stdout = result.stdout.toString()

    // Must be valid JSON
    const output = JSON.parse(stdout)

    // Required fields
    expect(output).toHaveProperty("chunks_indexed")
    expect(output).toHaveProperty("source_namespace")
    expect(output).toHaveProperty("manifest_path")
    expect(output).toHaveProperty("index_path")
    expect(output).toHaveProperty("indexed_at")

    // No secrets
    const serialized = JSON.stringify(output)
    expect(serialized).not.toContain("secret-should-not-leak")
    expect(serialized).not.toContain("AGENT_EMBEDDING_API_KEY")
    expect(serialized).not.toContain("api_key")
  })

  test("source DB remains byte-for-byte unchanged after build", async () => {
    const sourceDbPath = createFixtureDb("cli-unchanged")
    const before = checksum(sourceDbPath)
    const vectorDbPath = tempPath("cli-unchanged-vector", "")
    const manifestPath = tempPath("cli-unchanged-manifest", ".json")

    await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath}`.env(getEmbeddingEnv()).nothrow().quiet()

    const after = checksum(sourceDbPath)
    expect(after.bytes).toBe(before.bytes)
    expect(after.sha256).toBe(before.sha256)
  })

  test("--limit 1 indexes only the first session from a multi-session fixture", async () => {
    const sourceDbPath = createMultiSessionFixtureDb("cli-limit")
    const before = checksum(sourceDbPath)
    const vectorDbPath = tempPath("cli-limit-vector", "")
    const manifestPath = tempPath("cli-limit-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --limit 1 \
      --json`.env(getEmbeddingEnv()).nothrow().quiet()

    const after = checksum(sourceDbPath)
    expect(after).toEqual(before)

    if (result.exitCode !== 0) {
      throw new Error(`CLI failed: ${result.stderr.toString()}`)
    }

    const output = JSON.parse(result.stdout.toString())
    // Total sessions in DB is 3, but only 1 session's chunks indexed
    expect(output.stats.sessions).toBe(3)
    expect(output.chunks_indexed).toBe(1)
  })

  test("--limit 0 fails with controlled error", async () => {
    const sourceDbPath = createFixtureDb("cli-limit-zero")
    const vectorDbPath = tempPath("cli-limit-zero-vector", "")
    const manifestPath = tempPath("cli-limit-zero-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --limit 0`.env(getEmbeddingEnv()).nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("positive integer")
  })

  test("--limit negative fails with controlled error", async () => {
    const sourceDbPath = createFixtureDb("cli-limit-neg")
    const vectorDbPath = tempPath("cli-limit-neg-vector", "")
    const manifestPath = tempPath("cli-limit-neg-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --limit -5`.env(getEmbeddingEnv()).nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("positive integer")
  })

  test("--limit non-integer fails with controlled error", async () => {
    const sourceDbPath = createFixtureDb("cli-limit-nan")
    const vectorDbPath = tempPath("cli-limit-nan-vector", "")
    const manifestPath = tempPath("cli-limit-nan-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --limit abc`.env(getEmbeddingEnv()).nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("positive integer")
  })

  test("--limit 1.5 fails with controlled error", async () => {
    const sourceDbPath = createFixtureDb("cli-limit-float")
    const vectorDbPath = tempPath("cli-limit-float-vector", "")
    const manifestPath = tempPath("cli-limit-float-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --limit 1.5`.env(getEmbeddingEnv()).nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("positive integer")
  })

  test("--limit 1abc fails with controlled error", async () => {
    const sourceDbPath = createFixtureDb("cli-limit-partial")
    const vectorDbPath = tempPath("cli-limit-partial-vector", "")
    const manifestPath = tempPath("cli-limit-partial-manifest", ".json")

    const result = await $`bun --conditions=development run ${CLI_ENTRY} session-vector build \
      --db ${sourceDbPath} \
      --index ${vectorDbPath} \
      --manifest ${manifestPath} \
      --limit 1abc`.env(getEmbeddingEnv()).nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    const stderr = result.stderr.toString()
    expect(stderr).toContain("positive integer")
  })
})