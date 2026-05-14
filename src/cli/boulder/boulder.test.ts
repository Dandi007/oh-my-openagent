import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "bun:test"

import { boulder } from "./boulder"
import { writeBoulderState, writeBoulderWork, writeBoulderIndex, readBoulderIndex, BOULDER_DIR, BOULDER_INDEX_PATH } from "../../features/boulder-state"

function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "omo-boulder-cli-"))
}

function seedPlanAndState(directory: string): void {
  const planDirectory = join(directory, ".sisyphus", "plans")
  mkdirSync(planDirectory, { recursive: true })

  const planAPath = join(planDirectory, "alpha.md")
  const planBPath = join(planDirectory, "beta.md")

  writeFileSync(
    planAPath,
    [
      "## TODOs",
      "- [x] 1. Alpha task done",
      "- [ ] 2. Alpha task running",
    ].join("\n"),
    "utf-8",
  )
  writeFileSync(
    planBPath,
    [
      "## TODOs",
      "- [x] 1. Beta task done",
      "- [x] 2. Beta task done too",
    ].join("\n"),
    "utf-8",
  )

  writeBoulderState(
    directory,
    {
      schema_version: 3,
      works: {
          "work-alpha": {
            work_id: "work-alpha",
            active_plan: planAPath,
            plan_name: "alpha",
            status: "active",
            started_at: "2026-05-10T00:00:00.000Z",
            elapsed_ms: 1_800_000,
            updated_at: "2026-05-10T00:30:00.000Z",
            session_ids: ["ses-1", "ses-2"],
            task_sessions: {
              "todo:2": {
                task_key: "todo:2",
                task_label: "2",
                task_title: "Alpha task running",
                session_id: "ses-2",
                elapsed_ms: 60000,
                status: "running",
                updated_at: "2026-05-10T00:30:00.000Z",
              },
            },
          },
          "work-beta": {
            work_id: "work-beta",
            active_plan: planBPath,
            plan_name: "beta",
            status: "completed",
            started_at: "2026-05-10T01:00:00.000Z",
            ended_at: "2026-05-10T01:10:00.000Z",
            elapsed_ms: 600000,
            updated_at: "2026-05-10T01:10:00.000Z",
            session_ids: ["ses-3"],
            task_sessions: {},
          },
        },
      },
  )
}

describe("boulder command", () => {
  const createdDirectories: string[] = []
  const outputRestores: Array<() => void> = []

  afterEach(() => {
    for (const directory of createdDirectories) {
      rmSync(directory, { recursive: true, force: true })
    }
    createdDirectories.length = 0
    for (const restoreOutput of outputRestores) {
      restoreOutput()
    }
    outputRestores.length = 0
  })

  function captureOutput(target: "stdout" | "stderr", sink: { value: string }): void {
    const originalWrite = process[target].write
    process[target].write = ((chunk: string | Uint8Array) => {
      sink.value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8")
      return true
    }) as typeof process.stdout.write

    outputRestores.push(() => {
      process[target].write = originalWrite
    })
  }

  it("prints multi-work text mode with plan names and percentages", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    const stdout = { value: "" }
    const stderr = { value: "" }
    captureOutput("stdout", stdout)
    captureOutput("stderr", stderr)

    const exitCode = await boulder({ directory })

    expect(exitCode).toBe(0)
    expect(stderr.value).toBe("")
    expect(stdout.value).toContain("plan: alpha")
    expect(stdout.value).toContain("plan: beta")
    expect(stdout.value).toContain("progress: 50% (1/2)")
    expect(stdout.value).toContain("progress: 100% (2/2)")
    expect(stdout.value).toContain("elapsed:")
  })

  it("prints json mode with expected fields", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    const stdout = { value: "" }
    captureOutput("stdout", stdout)

    const exitCode = await boulder({ directory, json: true })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdout.value)
    expect(parsed.works).toHaveLength(2)
    expect(parsed.works[0]).toHaveProperty("work_id")
    expect(parsed.works[0]).toHaveProperty("percentage")
    expect(parsed.works[0]).toHaveProperty("remaining_tasks")
  })

  it("returns 1 when boulder state does not exist", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)

    const stderr = { value: "" }
    captureOutput("stderr", stderr)

    const exitCode = await boulder({ directory })
    expect(exitCode).toBe(1)
    expect(stderr.value).toContain("No boulder state found")
  })

  it("returns 1 when workId filter matches none", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    const stderr = { value: "" }
    captureOutput("stderr", stderr)

    const exitCode = await boulder({ directory, workId: "missing" })
    expect(exitCode).toBe(1)
    expect(stderr.value).toContain("No boulder state found")
  })

  it("returns one work when workId filter matches", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    const stdout = { value: "" }
    captureOutput("stdout", stdout)

    const exitCode = await boulder({ directory, workId: "work-beta", json: true })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdout.value)
    expect(parsed.works).toHaveLength(1)
    expect(parsed.works[0].work_id).toBe("work-beta")
  })

  // ─── Edge case: corrupt index.json ──────────────────────────────

  it("still lists works when index.json is corrupt (non-JSON)", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    // Corrupt the index
    const indexPath = join(directory, BOULDER_INDEX_PATH)
    writeFileSync(indexPath, "not valid json {{{")

    const stdout = { value: "" }
    captureOutput("stdout", stdout)

    const exitCode = await boulder({ directory, json: true })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdout.value)
    expect(parsed.works.length).toBeGreaterThanOrEqual(1)
  })

  it("still lists works when index.json is empty", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    // Empty the index
    const indexPath = join(directory, BOULDER_INDEX_PATH)
    writeFileSync(indexPath, "")

    const stdout = { value: "" }
    captureOutput("stdout", stdout)

    const exitCode = await boulder({ directory, json: true })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdout.value)
    expect(parsed.works.length).toBeGreaterThanOrEqual(1)
  })

  it("still lists works when index.json has wrong schema_version", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)
    seedPlanAndState(directory)

    // Write index with wrong schema version
    const indexPath = join(directory, BOULDER_INDEX_PATH)
    writeFileSync(indexPath, JSON.stringify({ schema_version: 2, sessions: {} }))

    const stdout = { value: "" }
    captureOutput("stdout", stdout)

    const exitCode = await boulder({ directory, json: true })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdout.value)
    expect(parsed.works.length).toBeGreaterThanOrEqual(1)
  })

  // ─── Edge case: orphan work file ────────────────────────────────

  it("lists orphan work files (no index entry)", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)

    const planDirectory = join(directory, ".sisyphus", "plans")
    mkdirSync(planDirectory, { recursive: true })
    const planPath = join(planDirectory, "orphan.md")
    writeFileSync(planPath, "## TODOs\n- [ ] 1. Orphan task\n", "utf-8")

    // Write work file directly without index
    writeBoulderWork(directory, "orphan-work", {
      work_id: "orphan-work",
      active_plan: planPath,
      plan_name: "orphan",
      status: "active",
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
      session_ids: ["orphan-ses"],
    })

    const stdout = { value: "" }
    captureOutput("stdout", stdout)

    const exitCode = await boulder({ directory, json: true })
    expect(exitCode).toBe(0)

    const parsed = JSON.parse(stdout.value)
    expect(parsed.works).toHaveLength(1)
    expect(parsed.works[0].work_id).toBe("orphan-work")
    expect(parsed.works[0].plan_name).toBe("orphan")
  })

  // ─── Edge case: missing work file ───────────────────────────────

  it("returns 2 when boulder file exists but state is unreadable", async () => {
    const directory = createTempDirectory()
    createdDirectories.push(directory)

    // Create v2 boulder.json (so the CLI knows boulder state "exists")
    const sisyphusDir = join(directory, ".sisyphus")
    mkdirSync(sisyphusDir, { recursive: true })
    writeFileSync(join(sisyphusDir, "boulder.json"), "not valid json {{{")

    const stderr = { value: "" }
    captureOutput("stderr", stderr)

    const exitCode = await boulder({ directory })
    expect(exitCode).toBe(2)
    expect(stderr.value).toContain("Failed to read boulder state")
  })
})
