import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import {
  migrateBoulderV2ToV3,
  readBoulderState,
  readBoulderWork,
  readBoulderIndex,
  listBoulderWorkIds,
  clearBoulderState,
} from "./storage"
import { BOULDER_DIR, BOULDER_INDEX_PATH, BOULDER_MIGRATED_PATH, BOULDER_V2_STATE_PATH, BOULDER_V2_BACKUP_SUFFIX } from "./constants"

/** Path to the v2 sample fixture from evidence */
const V2_SAMPLE_PATH = join(
  import.meta.dir,
  "..", "..", "..", ".sisyphus", "evidence", "boulder-multi-session", "task-1-v2-sample.json",
)

describe("migrateBoulderV2ToV3", () => {
  const TEST_DIR = join(tmpdir(), "boulder-migration-test-" + Date.now())
  const SISYPHUS_DIR = join(TEST_DIR, ".sisyphus")

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true })
    }
    if (!existsSync(SISYPHUS_DIR)) {
      mkdirSync(SISYPHUS_DIR, { recursive: true })
    }
    clearBoulderState(TEST_DIR)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  // ─── full migration ──────────────────────────────────────────────

  test("should migrate v2 boulder.json to v3 multi-file storage", () => {
    // Copy v2 sample to test directory
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    const result = migrateBoulderV2ToV3(TEST_DIR)
    expect(result).toBe(true)

    // Verify v2 file was renamed to backup
    expect(existsSync(v2Path)).toBe(false)
    expect(existsSync(v2Path + BOULDER_V2_BACKUP_SUFFIX)).toBe(true)

    // Verify migration marker exists
    expect(existsSync(join(TEST_DIR, BOULDER_MIGRATED_PATH))).toBe(true)

    // Verify work files exist
    const workIds = listBoulderWorkIds(TEST_DIR)
    expect(workIds.length).toBe(2)
    expect(workIds).toContain("work-branch-build-baseline")
    expect(workIds).toContain("work-migration-fixture")

    // Verify work content
    const work1 = readBoulderWork(TEST_DIR, "work-branch-build-baseline")
    expect(work1).not.toBeNull()
    expect(work1?.work_id).toBe("work-branch-build-baseline")
    expect(work1?.plan_name).toBe("boulder-multi-session-refactor")
    expect(work1?.status).toBe("completed")
    expect(work1?.session_ids).toContain("ses_sample_orchestrator_001")
    expect(work1?.session_ids).toContain("ses_sample_task_001")

    const work2 = readBoulderWork(TEST_DIR, "work-migration-fixture")
    expect(work2).not.toBeNull()
    expect(work2?.work_id).toBe("work-migration-fixture")
    // "pending" is not a valid v3 BoulderWorkStatus — correctly dropped
    expect(work2?.status).toBeUndefined()

    // Verify index exists and is valid
    const index = readBoulderIndex(TEST_DIR)
    expect(index).not.toBeNull()
    expect(index?.schema_version).toBe(3)
    expect(index?.sessions["ses_sample_orchestrator_001"]).toBeDefined()
    expect(index?.sessions["ses_sample_task_001"]).toBeDefined()
    expect(index?.sessions["ses_sample_task_002"]).toBeDefined()

    // Verify readBoulderState returns v3 state
    const state = readBoulderState(TEST_DIR)
    expect(state).not.toBeNull()
    expect(state?.schema_version).toBe(3)
    expect(Object.keys(state?.works ?? {}).length).toBe(2)
  })

  // ─── idempotency ─────────────────────────────────────────────────

  test("should be idempotent — second call is no-op", () => {
    // Copy v2 sample and migrate once
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    const firstResult = migrateBoulderV2ToV3(TEST_DIR)
    expect(firstResult).toBe(true)

    // Second call should succeed (idempotent)
    const secondResult = migrateBoulderV2ToV3(TEST_DIR)
    expect(secondResult).toBe(true)

    // Work files should still be intact
    const workIds = listBoulderWorkIds(TEST_DIR)
    expect(workIds.length).toBe(2)

    // Index should still be valid
    const index = readBoulderIndex(TEST_DIR)
    expect(index).not.toBeNull()
  })

  test("should re-migrate if marker exists but index is corrupt", () => {
    // Copy v2 sample and migrate once
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    const firstResult = migrateBoulderV2ToV3(TEST_DIR)
    expect(firstResult).toBe(true)

    // Corrupt the index
    const indexPath = join(TEST_DIR, BOULDER_INDEX_PATH)
    writeFileSync(indexPath, "not valid json {{{", "utf-8")

    // Restore v2 file (simulate that backup was restored)
    writeFileSync(v2Path, v2Content, "utf-8")

    // Re-migration should succeed
    const reResult = migrateBoulderV2ToV3(TEST_DIR)
    expect(reResult).toBe(true)

    // Index should be valid again
    const index = readBoulderIndex(TEST_DIR)
    expect(index).not.toBeNull()
  })

  // ─── failure recovery ────────────────────────────────────────────

  test("should recover from partial migration — work files preserved on retry", () => {
    // Copy v2 sample
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    // Simulate partial migration: write one work file manually
    // but don't write index or marker
    const boulderDir = join(TEST_DIR, BOULDER_DIR)
    mkdirSync(boulderDir, { recursive: true })
    writeFileSync(join(boulderDir, "work-branch-build-baseline.json"), JSON.stringify({
      work_id: "work-branch-build-baseline",
      active_plan: "/Volumes/Data/code/worktrees/oh-my-openagent/boulder-multi-session/.sisyphus/plans/boulder-multi-session-refactor.md",
      plan_name: "boulder-multi-session-refactor",
      status: "completed",
      started_at: "2026-05-13T15:03:14.000Z",
      session_ids: ["ses_sample_orchestrator_001", "ses_sample_task_001"],
    }), "utf-8")

    // Now run migration — should skip the already-existing work file
    const result = migrateBoulderV2ToV3(TEST_DIR)
    expect(result).toBe(true)

    // Both work files should exist
    const workIds = listBoulderWorkIds(TEST_DIR)
    expect(workIds.length).toBe(2)

    // Index should be valid
    const index = readBoulderIndex(TEST_DIR)
    expect(index).not.toBeNull()

    // Marker should exist
    expect(existsSync(join(TEST_DIR, BOULDER_MIGRATED_PATH))).toBe(true)
  })

  test("should NOT write .migrated marker if index write fails", () => {
    // Copy v2 sample
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    // Pre-create a read-only index.json to force write failure
    const boulderDir = join(TEST_DIR, BOULDER_DIR)
    mkdirSync(boulderDir, { recursive: true })
    const indexPath = join(TEST_DIR, BOULDER_INDEX_PATH)
    // Write a directory at the index path to make atomic write fail
    // (rename can't replace a directory with a file)
    mkdirSync(indexPath, { recursive: true })

    const result = migrateBoulderV2ToV3(TEST_DIR)
    // Should fail because index write fails
    expect(result).toBe(false)

    // .migrated marker should NOT exist
    expect(existsSync(join(TEST_DIR, BOULDER_MIGRATED_PATH))).toBe(false)

    // v2 file should NOT have been renamed (step 5 only runs after step 4 succeeds)
    expect(existsSync(v2Path)).toBe(true)

    // Clean up the directory so we can retry
    rmSync(indexPath, { recursive: true, force: true })

    // Retry should succeed
    const retryResult = migrateBoulderV2ToV3(TEST_DIR)
    expect(retryResult).toBe(true)

    // Now marker should exist
    expect(existsSync(join(TEST_DIR, BOULDER_MIGRATED_PATH))).toBe(true)
  })

  // ─── edge cases ──────────────────────────────────────────────────

  test("should return false when no v2 file exists", () => {
    const result = migrateBoulderV2ToV3(TEST_DIR)
    expect(result).toBe(false)
  })

  test("should return false for empty v2 file", () => {
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, "{}", "utf-8")

    const result = migrateBoulderV2ToV3(TEST_DIR)
    expect(result).toBe(false)
  })

  test("should return false for v2 file with no works and no mirror fields", () => {
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, JSON.stringify({
      schema_version: 2,
      session_ids: [],
    }), "utf-8")

    const result = migrateBoulderV2ToV3(TEST_DIR)
    expect(result).toBe(false)
  })

  test("should migrate v2 with mirror fields (no works array)", () => {
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, JSON.stringify({
      active_plan: "/path/to/legacy-plan.md",
      started_at: "2026-01-01T00:00:00.000Z",
      session_ids: ["legacy-session"],
      plan_name: "legacy-plan",
    }), "utf-8")

    const result = migrateBoulderV2ToV3(TEST_DIR)
    expect(result).toBe(true)

    const workIds = listBoulderWorkIds(TEST_DIR)
    expect(workIds.length).toBe(1)
    expect(workIds[0]).toContain("legacy-plan")

    const work = readBoulderWork(TEST_DIR, workIds[0])
    expect(work?.plan_name).toBe("legacy-plan")
    expect(work?.session_ids).toEqual(["legacy-session"])
  })

  // ─── readBoulderState auto-migration ─────────────────────────────

  test("readBoulderState should auto-migrate v2 when no .migrated marker", () => {
    // Copy v2 sample
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    // readBoulderState should auto-trigger migration
    const state = readBoulderState(TEST_DIR)
    expect(state).not.toBeNull()
    expect(state?.schema_version).toBe(3)
    expect(Object.keys(state?.works ?? {}).length).toBe(2)

    // After auto-migration, v2 file should be renamed
    expect(existsSync(v2Path)).toBe(false)
    expect(existsSync(v2Path + BOULDER_V2_BACKUP_SUFFIX)).toBe(true)

    // Marker should exist
    expect(existsSync(join(TEST_DIR, BOULDER_MIGRATED_PATH))).toBe(true)

    // Work files should exist
    const workIds = listBoulderWorkIds(TEST_DIR)
    expect(workIds.length).toBe(2)
  })

  test("readBoulderState should read v2 directly when .migrated exists but v3 is corrupt", () => {
    // Copy v2 sample
    const v2Content = readFileSync(V2_SAMPLE_PATH, "utf-8")
    const v2Path = join(TEST_DIR, BOULDER_V2_STATE_PATH)
    mkdirSync(dirname(v2Path), { recursive: true })
    writeFileSync(v2Path, v2Content, "utf-8")

    // Migrate first
    migrateBoulderV2ToV3(TEST_DIR)

    // Corrupt all v3 work files
    const boulderDir = join(TEST_DIR, BOULDER_DIR)
    const workIds = listBoulderWorkIds(TEST_DIR)
    for (const wid of workIds) {
      writeFileSync(join(boulderDir, `${wid}.json`), "corrupt {{{", "utf-8")
    }

    // Restore v2 file (simulate backup was restored)
    writeFileSync(v2Path, v2Content, "utf-8")

    // readBoulderState should fall back to reading v2 directly
    const state = readBoulderState(TEST_DIR)
    expect(state).not.toBeNull()
    expect(state?.schema_version).toBe(3)
    expect(Object.keys(state?.works ?? {}).length).toBe(2)
  })
})