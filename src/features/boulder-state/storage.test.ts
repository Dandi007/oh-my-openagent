import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  addBoulderWork,
  appendSessionIdForWork,
  completeBoulder,
  endTaskTimer,
  getActiveWorks,
  getBoulderWorks,
  readBoulderState,
  writeBoulderState,
  appendSessionId,
  clearBoulderState,
  getWorkById,
  getWorkByPlanName,
  getWorkForSession,
  getWorkResumeOptions,
  getPlanProgress,
  createBoulderState,
  findPrometheusPlans,
  getTaskSessionState,
  resolveBoulderPlanPath,
  resolveBoulderPlanPathForWork,
  selectActiveWork,
  startTaskTimer,
  upsertTaskSessionState,
  upsertTaskSessionStateForWork,
  readBoulderWork,
  writeBoulderWork,
  listBoulderWorkIds,
  readBoulderIndex,
  writeBoulderIndex,
  rebuildIndexFromWorkFiles,
  listBoulderWorks,
} from "./storage"
import type { BoulderState, BoulderWorkState } from "./types"
import { readCurrentTopLevelTask } from "./top-level-task"
import { BOULDER_DIR, BOULDER_INDEX_PATH, BOULDER_V2_STATE_PATH } from "./constants"

/** Helper: get the first (and usually only) work from a v3 BoulderState */
function firstWork(state: BoulderState): BoulderWorkState | null {
  const works = Object.values(state.works)
  return works[0] ?? null
}

describe("boulder-state", () => {
  const TEST_DIR = join(tmpdir(), "boulder-state-test-" + Date.now())
  const SISYPHUS_DIR = join(TEST_DIR, ".sisyphus")
  const BOULDER_SUBDIR = join(TEST_DIR, BOULDER_DIR)

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

  // ─── v3 core functions ──────────────────────────────────────────

  describe("readBoulderWork / writeBoulderWork", () => {
    test("should write and read a single work file", () => {
      const work: BoulderWorkState = {
        work_id: "test-work-001",
        active_plan: "/path/to/plan.md",
        plan_name: "test-plan",
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["session-1"],
      }

      const wrote = writeBoulderWork(TEST_DIR, "test-work-001", work)
      expect(wrote).toBe(true)

      const read = readBoulderWork(TEST_DIR, "test-work-001")
      expect(read).not.toBeNull()
      expect(read?.work_id).toBe("test-work-001")
      expect(read?.plan_name).toBe("test-plan")
    })

    test("should return null for non-existent work", () => {
      const result = readBoulderWork(TEST_DIR, "nonexistent")
      expect(result).toBeNull()
    })

    test("should return null when work_id doesn't match filename", () => {
      const work: BoulderWorkState = {
        work_id: "wrong-id",
        active_plan: "/plan.md",
        plan_name: "plan",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: [],
      }
      writeBoulderWork(TEST_DIR, "correct-id", work)
      const result = readBoulderWork(TEST_DIR, "correct-id")
      expect(result).toBeNull()
    })

    test("should return null for corrupt JSON", () => {
      const boulderDir = join(TEST_DIR, BOULDER_DIR)
      mkdirSync(boulderDir, { recursive: true })
      writeFileSync(join(boulderDir, "corrupt.json"), "not valid json {{{")
      const result = readBoulderWork(TEST_DIR, "corrupt")
      expect(result).toBeNull()
    })
  })

  describe("listBoulderWorkIds", () => {
    test("should return empty array when boulder dir doesn't exist", () => {
      const ids = listBoulderWorkIds(TEST_DIR)
      expect(ids).toEqual([])
    })

    test("should list work IDs excluding index.json", () => {
      writeBoulderWork(TEST_DIR, "work-a", {
        work_id: "work-a", active_plan: "/a.md", plan_name: "a",
        started_at: "2026-01-01T00:00:00.000Z", session_ids: [],
      })
      writeBoulderWork(TEST_DIR, "work-b", {
        work_id: "work-b", active_plan: "/b.md", plan_name: "b",
        started_at: "2026-01-01T00:00:00.000Z", session_ids: [],
      })
      // Also write index to ensure it's excluded
      writeBoulderIndex(TEST_DIR, { schema_version: 3, sessions: {} })

      const ids = listBoulderWorkIds(TEST_DIR)
      expect(ids).toContain("work-a")
      expect(ids).toContain("work-b")
      expect(ids).not.toContain("index")
    })
  })

  describe("readBoulderIndex / writeBoulderIndex", () => {
    test("should write and read index", () => {
      const index = { schema_version: 3 as const, sessions: { "ses-1": "work-a", "ses-2": "work-b" } }
      const wrote = writeBoulderIndex(TEST_DIR, index)
      expect(wrote).toBe(true)

      const read = readBoulderIndex(TEST_DIR)
      expect(read).not.toBeNull()
      expect(read?.sessions).toEqual({ "ses-1": "work-a", "ses-2": "work-b" })
    })

    test("should return null when index doesn't exist", () => {
      const result = readBoulderIndex(TEST_DIR)
      expect(result).toBeNull()
    })

    test("should return null for wrong schema version", () => {
      const filePath = join(TEST_DIR, BOULDER_INDEX_PATH)
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify({ schema_version: 2, sessions: {} }))
      const result = readBoulderIndex(TEST_DIR)
      expect(result).toBeNull()
    })
  })

  describe("rebuildIndexFromWorkFiles", () => {
    test("should return empty index when no work files exist", () => {
      const index = rebuildIndexFromWorkFiles(TEST_DIR)
      expect(index.schema_version).toBe(3)
      expect(index.sessions).toEqual({})
    })

    test("should rebuild index from work files", () => {
      writeBoulderWork(TEST_DIR, "work-a", {
        work_id: "work-a", active_plan: "/a.md", plan_name: "a",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["ses-1", "ses-2"],
      })
      writeBoulderWork(TEST_DIR, "work-b", {
        work_id: "work-b", active_plan: "/b.md", plan_name: "b",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["ses-3"],
      })

      const index = rebuildIndexFromWorkFiles(TEST_DIR)
      expect(index.sessions).toEqual({
        "ses-1": "work-a",
        "ses-2": "work-a",
        "ses-3": "work-b",
      })
    })

    test("should skip corrupt work files", () => {
      writeBoulderWork(TEST_DIR, "good", {
        work_id: "good", active_plan: "/g.md", plan_name: "g",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["ses-ok"],
      })
      // Write corrupt file
      const boulderDir = join(TEST_DIR, BOULDER_DIR)
      writeFileSync(join(boulderDir, "bad.json"), "not json {{{")

      const index = rebuildIndexFromWorkFiles(TEST_DIR)
      expect(index.sessions).toEqual({ "ses-ok": "good" })
    })

    test("should handle duplicate session IDs (last wins)", () => {
      writeBoulderWork(TEST_DIR, "work-a", {
        work_id: "work-a", active_plan: "/a.md", plan_name: "a",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["shared-ses"],
      })
      writeBoulderWork(TEST_DIR, "work-b", {
        work_id: "work-b", active_plan: "/b.md", plan_name: "b",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["shared-ses"],
      })

      const index = rebuildIndexFromWorkFiles(TEST_DIR)
      // One of the works wins (order is filesystem-dependent)
      expect(["work-a", "work-b"]).toContain(index.sessions["shared-ses"])
    })
  })

  describe("listBoulderWorks", () => {
    test("should return empty array when no works exist", () => {
      const works = listBoulderWorks(TEST_DIR)
      expect(works).toEqual([])
    })

    test("should return all works sorted by updated_at descending", () => {
      writeBoulderWork(TEST_DIR, "older", {
        work_id: "older", active_plan: "/o.md", plan_name: "older",
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        session_ids: [],
      })
      writeBoulderWork(TEST_DIR, "newer", {
        work_id: "newer", active_plan: "/n.md", plan_name: "newer",
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        session_ids: [],
      })

      const works = listBoulderWorks(TEST_DIR)
      expect(works.length).toBe(2)
      expect(works[0].work_id).toBe("newer")
      expect(works[1].work_id).toBe("older")
    })
  })

  // ─── readBoulderState ───────────────────────────────────────────

  describe("readBoulderState", () => {
    test("should read v3 state from work files", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/path/to/plan.md",
            plan_name: "my-plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1", "session-2"],
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      const result = readBoulderState(TEST_DIR)
      expect(result).not.toBeNull()
      expect(result?.schema_version).toBe(3)
      const w = firstWork(result!)
      expect(w?.active_plan).toBe("/path/to/plan.md")
      expect(w?.session_ids).toEqual(["session-1", "session-2"])
      expect(w?.plan_name).toBe("my-plan")
    })

    test("should read legacy v2 boulder.json and convert to v3", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      const legacyRawState = {
        active_plan: "/path/to/legacy-plan.md",
        started_at: "2026-01-01T00:00:00.000Z",
        session_ids: ["legacy-session"],
        plan_name: "legacy-plan",
      }
      writeFileSync(boulderFile, JSON.stringify(legacyRawState, null, 2), "utf-8")

      const state = readBoulderState(TEST_DIR)
      expect(state).not.toBeNull()
      expect(state?.schema_version).toBe(3)
      const w = firstWork(state!)
      expect(w?.active_plan).toBe(legacyRawState.active_plan)
      expect(w?.started_at).toBe(legacyRawState.started_at)
      expect(w?.session_ids).toEqual(legacyRawState.session_ids)
      expect(w?.plan_name).toBe(legacyRawState.plan_name)
    })

    test("should return null when no state exists", () => {
      const result = readBoulderState(TEST_DIR)
      expect(result).toBeNull()
    })

    test("should return null for JSON null value in v2 file", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, "null")
      const result = readBoulderState(TEST_DIR)
      expect(result).toBeNull()
    })

    test("should return null for JSON primitive value in v2 file", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, '"just a string"')
      const result = readBoulderState(TEST_DIR)
      expect(result).toBeNull()
    })

    test("should default session_ids to [] when missing from v2 JSON", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        plan_name: "plan",
      }))
      const result = readBoulderState(TEST_DIR)
      expect(result).not.toBeNull()
      const w = firstWork(result!)
      expect(w?.session_ids).toEqual([])
    })

    test("should default session_ids to [] when not an array in v2", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: "not-an-array",
        plan_name: "plan",
      }))
      const result = readBoulderState(TEST_DIR)
      expect(result).not.toBeNull()
      const w = firstWork(result!)
      expect(w?.session_ids).toEqual([])
    })

    test("should default session_ids to [] for empty v2 object", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({}))
      const result = readBoulderState(TEST_DIR)
      // Empty v2 object has no active_plan/plan_name/started_at, so no work can be built
      expect(result).toBeNull()
    })

    test("should backfill missing origin as direct for single tracked session in v2", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }))
      const result = readBoulderState(TEST_DIR)
      const w = firstWork(result!)
      expect(w?.session_origins).toEqual({ "session-1": "direct" })
    })

    test("should keep missing origins empty when multiple sessions in v2", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["session-1", "session-2"],
        plan_name: "plan",
      }))
      const result = readBoulderState(TEST_DIR)
      const w = firstWork(result!)
      expect(w?.session_origins).toEqual({})
    })

    test("should default task_sessions to empty object when missing from v2 JSON", () => {
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }))
      const result = readBoulderState(TEST_DIR)
      const w = firstWork(result!)
      expect(w?.task_sessions).toEqual({})
    })
  })

  // ─── writeBoulderState ──────────────────────────────────────────

  describe("writeBoulderState", () => {
    test("should write v3 state and create boulder directory if needed", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/test/plan.md",
            plan_name: "test-plan",
            status: "active",
            started_at: "2026-01-02T12:00:00Z",
            updated_at: "2026-01-02T12:00:00Z",
            session_ids: ["ses-123"],
          },
        },
      }

      const success = writeBoulderState(TEST_DIR, state)
      const readBack = readBoulderState(TEST_DIR)

      expect(success).toBe(true)
      expect(readBack).not.toBeNull()
      const w = firstWork(readBack!)
      expect(w?.active_plan).toBe("/test/plan.md")
      // Verify work file exists on disk
      expect(existsSync(join(BOULDER_SUBDIR, "work-1.json"))).toBe(true)
      // Verify index exists on disk
      expect(existsSync(join(TEST_DIR, BOULDER_INDEX_PATH))).toBe(true)
    })
  })

  // ─── appendSessionId ────────────────────────────────────────────

  describe("appendSessionId", () => {
    test("should append new session id to existing state", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/plan.md",
            plan_name: "plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1"],
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      const result = appendSessionId(TEST_DIR, "session-2")
      expect(result).not.toBeNull()
      const w = firstWork(result!)
      expect(w?.session_ids).toEqual(["session-1", "session-2"])
    })

    test("should not duplicate existing session id", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/plan.md",
            plan_name: "plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1"],
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      appendSessionId(TEST_DIR, "session-1")
      const result = readBoulderState(TEST_DIR)
      const w = firstWork(result!)
      expect(w?.session_ids).toEqual(["session-1"])
    })

    test("should return null when no state exists", () => {
      const result = appendSessionId(TEST_DIR, "new-session")
      expect(result).toBeNull()
    })

    test("should persist appended session origin when provided", () => {
      writeBoulderState(TEST_DIR, {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/path/to/plan.md",
            plan_name: "plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1"],
            session_origins: { "session-1": "direct" },
          },
        },
      })

      const result = appendSessionId(TEST_DIR, "session-2", "appended")
      const w = firstWork(result!)
      expect(w?.session_origins).toEqual({
        "session-1": "direct",
        "session-2": "appended",
      })
    })
  })

  // ─── clearBoulderState ──────────────────────────────────────────

  describe("clearBoulderState", () => {
    test("should remove v3 boulder directory", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/plan.md",
            plan_name: "plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1"],
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      const success = clearBoulderState(TEST_DIR)
      const result = readBoulderState(TEST_DIR)

      expect(success).toBe(true)
      expect(result).toBeNull()
    })

    test("should succeed even when no files exist", () => {
      const success = clearBoulderState(TEST_DIR)
      expect(success).toBe(true)
    })
  })

  // ─── task session state ─────────────────────────────────────────

  describe("task session state", () => {
    test("should persist and read preferred session for a top-level plan task", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/plan.md",
            plan_name: "plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1"],
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      upsertTaskSessionState(TEST_DIR, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "Implement auth flow",
        sessionId: "ses_task_123",
        agent: "sisyphus-junior",
        category: "deep",
      })
      const result = getTaskSessionState(TEST_DIR, "todo:1")

      expect(result).not.toBeNull()
      expect(result?.session_id).toBe("ses_task_123")
      expect(result?.task_title).toBe("Implement auth flow")
      expect(result?.agent).toBe("sisyphus-junior")
      expect(result?.category).toBe("deep")
    })

    test("should overwrite preferred session for the same top-level plan task", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-1": {
            work_id: "work-1",
            active_plan: "/plan.md",
            plan_name: "plan",
            status: "active",
            started_at: "2026-01-02T10:00:00Z",
            updated_at: "2026-01-02T10:00:00Z",
            session_ids: ["session-1"],
            task_sessions: {
              "todo:1": {
                task_key: "todo:1",
                task_label: "1",
                task_title: "Implement auth flow",
                session_id: "ses_old",
                updated_at: "2026-01-02T10:00:00Z",
              },
            },
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      upsertTaskSessionState(TEST_DIR, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "Implement auth flow",
        sessionId: "ses_new",
      })
      const result = getTaskSessionState(TEST_DIR, "todo:1")

      expect(result?.session_id).toBe("ses_new")
    })
  })

  // ─── multi-work helpers ─────────────────────────────────────────

  describe("multi-work helpers", () => {
    test("should add second work and keep both active works", () => {
      const firstState = createBoulderState(
        join(TEST_DIR, ".sisyphus/plans/plan-a.md"),
        "session-a",
        "atlas",
        "/worktree-a",
      )
      writeBoulderState(TEST_DIR, firstState)
      const firstWorkId = Object.keys(firstState.works)[0]

      const updatedState = addBoulderWork(TEST_DIR, {
        planPath: join(TEST_DIR, ".sisyphus/plans/plan-b.md"),
        sessionId: "session-b",
        agent: "atlas",
        worktreePath: "/worktree-b",
      })

      expect(updatedState).not.toBeNull()
      const works = updatedState?.works ?? {}
      expect(Object.keys(works).length).toBe(2)
      expect(firstWorkId).toBeDefined()
      expect(works[firstWorkId!]).toBeDefined()
      expect(getActiveWorks(TEST_DIR).length).toBe(2)
    })

    test("should resolve work for session using updated_at tie-break", async () => {
      const baseState = createBoulderState(
        join(TEST_DIR, ".sisyphus/plans/plan-a.md"),
        "session-a",
      )
      writeBoulderState(TEST_DIR, baseState)
      const stateWithSecond = addBoulderWork(TEST_DIR, {
        planPath: join(TEST_DIR, ".sisyphus/plans/plan-b.md"),
        sessionId: "session-b",
      })
      expect(stateWithSecond).not.toBeNull()

      const workIds = Object.keys(stateWithSecond!.works ?? {})
      expect(workIds.length).toBe(2)
      const firstWorkId = workIds.find((workId) => (stateWithSecond!.works?.[workId]?.plan_name ?? "") === "plan-a")!
      const secondWorkId = workIds.find((workId) => (stateWithSecond!.works?.[workId]?.plan_name ?? "") === "plan-b")!

      appendSessionIdForWork(TEST_DIR, secondWorkId, "session-a", "appended")
      // Small delay to ensure different updated_at timestamps
      await new Promise((resolve) => setTimeout(resolve, 2))
      appendSessionIdForWork(TEST_DIR, firstWorkId, "session-a", "appended")

      const resolvedWork = getWorkForSession(TEST_DIR, "session-a")
      expect(resolvedWork?.work_id).toBe(firstWorkId)
    })

    test("should support selecting active work and read helpers", () => {
      const initialState = createBoulderState(join(TEST_DIR, ".sisyphus/plans/plan-a.md"), "session-a")
      writeBoulderState(TEST_DIR, initialState)
      const added = addBoulderWork(TEST_DIR, {
        planPath: join(TEST_DIR, ".sisyphus/plans/plan-b.md"),
        sessionId: "session-b",
        worktreePath: "/tmp/worktree-b",
      })
      expect(added).not.toBeNull()
      const firstWork = getWorkByPlanName(TEST_DIR, "plan-a")
      expect(firstWork).not.toBeNull()

      const selected = selectActiveWork(TEST_DIR, firstWork!.work_id)
      const selectedById = getWorkById(TEST_DIR, firstWork!.work_id)
      const byPlanNameWithWorktree = getWorkByPlanName(TEST_DIR, "plan-b", { worktreePath: "/tmp/worktree-b" })
      const byPlanPath = resolveBoulderPlanPathForWork(TEST_DIR, firstWork!)
      const resumeOptions = getWorkResumeOptions(TEST_DIR)
      const worksFromState = getBoulderWorks(selected!)

      expect(selected?.works[firstWork!.work_id]).toBeDefined()
      expect(selectedById?.work_id).toBe(firstWork!.work_id)
      expect(byPlanNameWithWorktree?.plan_name).toBe("plan-b")
      expect(byPlanPath.endsWith("plan-a.md")).toBe(true)
      expect(resumeOptions.length).toBe(2)
      expect(worksFromState.length).toBe(2)
    })

    test("should upsert task session for specific work and keep first started_at", () => {
      const initialState = createBoulderState(join(TEST_DIR, ".sisyphus/plans/plan-a.md"), "session-a")
      writeBoulderState(TEST_DIR, initialState)
      const workId = Object.keys(initialState.works)[0]

      upsertTaskSessionStateForWork(TEST_DIR, workId, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "task one",
        sessionId: "task-session-a",
      })

      const seededState = readBoulderState(TEST_DIR)!
      seededState.works[workId]!.task_sessions!["todo:1"]!.started_at = "2026-01-01T00:00:00.000Z"
      writeBoulderState(TEST_DIR, seededState)

      const updated = upsertTaskSessionStateForWork(TEST_DIR, workId, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "task one",
        sessionId: "task-session-b",
      })

      expect(updated).not.toBeNull()
      const taskSession = updated?.works?.[workId]?.task_sessions?.["todo:1"]
      expect(taskSession?.session_id).toBe("task-session-b")
      expect(taskSession?.started_at).toBe("2026-01-01T00:00:00.000Z")
    })
  })

  describe("v3 index integration", () => {
    function work(workId: string, planName: string, sessionIds: string[], updatedAt = "2026-01-01T00:00:00.000Z"): BoulderWorkState {
      return {
        work_id: workId,
        active_plan: join(TEST_DIR, ".sisyphus", "plans", `${planName}.md`),
        plan_name: planName,
        status: "active",
        started_at: "2026-01-01T00:00:00.000Z",
        updated_at: updatedAt,
        session_ids: sessionIds,
        task_sessions: {},
      }
    }

    test("enumerates multiple work ids while excluding the index file", () => {
      writeBoulderState(TEST_DIR, {
        schema_version: 3,
        works: {
          "work-a": work("work-a", "plan-a", ["session-a"]),
          "work-b": work("work-b", "plan-b", ["session-b"]),
        },
      })

      expect(listBoulderWorkIds(TEST_DIR).sort()).toEqual(["work-a", "work-b"])
    })

    test("selects an active work without creating top-level mirror fields", () => {
      const state: BoulderState = {
        schema_version: 3,
        works: {
          "work-a": work("work-a", "plan-a", ["session-a"]),
          "work-b": work("work-b", "plan-b", ["session-b"]),
        },
      }
      writeBoulderState(TEST_DIR, state)

      const selected = selectActiveWork(TEST_DIR, "work-b")

      expect(selected?.works["work-b"]?.plan_name).toBe("plan-b")
      expect("active_plan" in (selected as unknown as Record<string, unknown>)).toBe(false)
      expect("session_ids" in (selected as unknown as Record<string, unknown>)).toBe(false)
    })

    test("isolates session lookup to the owning work file", () => {
      writeBoulderState(TEST_DIR, {
        schema_version: 3,
        works: {
          "work-a": work("work-a", "plan-a", ["session-a"]),
          "work-b": work("work-b", "plan-b", ["session-b"]),
        },
      })

      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
      expect(getWorkForSession(TEST_DIR, "session-a")?.session_ids).not.toContain("session-b")
    })

    test("resumes by work lookup using plan name and worktree path", () => {
      const workA = { ...work("work-a", "plan-a", ["session-a"]), worktree_path: "/tmp/work-a" }
      const workB = { ...work("work-b", "plan-a", ["session-b"]), worktree_path: "/tmp/work-b" }
      writeBoulderState(TEST_DIR, { schema_version: 3, works: { "work-a": workA, "work-b": workB } })

      expect(getWorkByPlanName(TEST_DIR, "plan-a", { worktreePath: "/tmp/work-b" })?.work_id).toBe("work-b")
    })

    test("builds CLI aggregate inputs from all indexed work files", () => {
      writeBoulderState(TEST_DIR, {
        schema_version: 3,
        works: {
          "work-a": work("work-a", "plan-a", ["session-a"], "2026-01-02T00:00:00.000Z"),
          "work-b": work("work-b", "plan-b", ["session-b"], "2026-01-03T00:00:00.000Z"),
        },
      })

      expect(readBoulderIndex(TEST_DIR)?.sessions).toEqual({ "session-a": "work-a", "session-b": "work-b" })
      expect(listBoulderWorks(TEST_DIR).map((item) => item.work_id)).toEqual(["work-b", "work-a"])
    })

    test("registers two sessions across independently written work files", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      writeBoulderWork(TEST_DIR, "work-b", work("work-b", "plan-b", ["session-b"]))

      const index = rebuildIndexFromWorkFiles(TEST_DIR)
      writeBoulderIndex(TEST_DIR, index)

      expect(readBoulderIndex(TEST_DIR)?.sessions).toEqual({ "session-a": "work-a", "session-b": "work-b" })
    })

    test("recovers a corrupt index by rebuilding from work files", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), "not json {{{")

      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(rebuildIndexFromWorkFiles(TEST_DIR).sessions).toEqual({ "session-a": "work-a" })
    })

    test("returns null for stale index entries whose work file is missing", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      writeBoulderIndex(TEST_DIR, { schema_version: 3, sessions: { "session-a": "work-a" } })
      rmSync(join(BOULDER_SUBDIR, "work-a.json"), { force: true })

      expect(getWorkForSession(TEST_DIR, "session-a")).toBeNull()
    })

    test("lists orphan work files even when index is missing", () => {
      writeBoulderWork(TEST_DIR, "orphan-work", work("orphan-work", "orphan-plan", ["orphan-ses"]))
      // No index written — orphan work file

      const works = listBoulderWorks(TEST_DIR)
      expect(works.length).toBe(1)
      expect(works[0].work_id).toBe("orphan-work")
    })

    test("readBoulderState returns orphan work files when index is missing", () => {
      writeBoulderWork(TEST_DIR, "orphan-work", work("orphan-work", "orphan-plan", ["orphan-ses"]))
      // No index written

      const state = readBoulderState(TEST_DIR)
      expect(state).not.toBeNull()
      expect(state?.works["orphan-work"]).toBeDefined()
      expect(state?.works["orphan-work"]?.plan_name).toBe("orphan-plan")
    })

    test("handles empty index.json gracefully", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), "")

      // Empty index should be treated as missing — fall back to scan
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json with wrong schema_version gracefully", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify({ schema_version: 2, sessions: { "session-a": "work-a" } }))

      // Wrong schema version should be treated as missing
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json with non-string session values gracefully", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify({ schema_version: 3, sessions: { "session-a": 123 } }))

      // Non-string values should invalidate the index
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json with array sessions gracefully", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify({ schema_version: 3, sessions: ["not-an-object"] }))

      // Array sessions should invalidate the index
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json with missing sessions field gracefully", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify({ schema_version: 3 }))

      // Missing sessions field should invalidate the index
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json with null sessions gracefully", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify({ schema_version: 3, sessions: null }))

      // Null sessions should invalidate the index
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json that is valid JSON but not an object", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify([1, 2, 3]))

      // Array instead of object should invalidate
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json that is a JSON primitive", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), JSON.stringify("just a string"))

      // Primitive should invalidate
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("handles index.json that is JSON null", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      mkdirSync(BOULDER_SUBDIR, { recursive: true })
      writeFileSync(join(TEST_DIR, BOULDER_INDEX_PATH), "null")

      // null should invalidate
      expect(readBoulderIndex(TEST_DIR)).toBeNull()
      expect(getWorkForSession(TEST_DIR, "session-a")?.work_id).toBe("work-a")
    })

    test("concurrent write to same work file does not corrupt data", () => {
      // Simulate concurrent writes by writing rapidly in sequence
      // atomicWriteJson uses .tmp + rename which is atomic on APFS
      for (let i = 0; i < 10; i++) {
        const w = work(`work-concurrent`, `plan-${i}`, [`session-${i}`], `2026-01-0${i + 1}T00:00:00.000Z`)
        writeBoulderWork(TEST_DIR, "work-concurrent", w)
      }

      const read = readBoulderWork(TEST_DIR, "work-concurrent")
      expect(read).not.toBeNull()
      expect(read?.work_id).toBe("work-concurrent")
      // The last write should have won (atomic rename guarantees this)
      expect(read?.plan_name).toBe("plan-9")
    })

    test("concurrent write to index does not corrupt data", () => {
      writeBoulderWork(TEST_DIR, "work-a", work("work-a", "plan-a", ["session-a"]))
      writeBoulderWork(TEST_DIR, "work-b", work("work-b", "plan-b", ["session-b"]))

      // Simulate concurrent index writes
      for (let i = 0; i < 5; i++) {
        writeBoulderIndex(TEST_DIR, { schema_version: 3, sessions: { [`session-${i}`]: "work-a" } })
      }

      const index = readBoulderIndex(TEST_DIR)
      expect(index).not.toBeNull()
      // The last write should have won
      expect(index?.sessions["session-4"]).toBe("work-a")
    })
  })

  // ─── task timer and completion helpers ──────────────────────────

  describe("task timer and completion helpers", () => {
    test("should keep started_at stable when starting timer repeatedly", () => {
      const initialState = createBoulderState(join(TEST_DIR, ".sisyphus/plans/plan-a.md"), "session-a")
      writeBoulderState(TEST_DIR, initialState)
      const workId = Object.keys(initialState.works)[0]

      startTaskTimer(TEST_DIR, workId, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "task one",
        sessionId: "session-a",
        startedAt: "2026-01-01T00:00:00.000Z",
      })
      startTaskTimer(TEST_DIR, workId, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "task one",
        sessionId: "session-a",
        startedAt: "2026-01-02T00:00:00.000Z",
      })

      const taskSession = readBoulderState(TEST_DIR)?.works?.[workId]?.task_sessions?.["todo:1"]
      expect(taskSession?.started_at).toBe("2026-01-01T00:00:00.000Z")
      expect(taskSession?.status).toBe("running")
    })

    test("should compute elapsed_ms when ending task timer", () => {
      const initialState = createBoulderState(join(TEST_DIR, ".sisyphus/plans/plan-a.md"), "session-a")
      writeBoulderState(TEST_DIR, initialState)
      const workId = Object.keys(initialState.works)[0]
      startTaskTimer(TEST_DIR, workId, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "task one",
        sessionId: "session-a",
        startedAt: "2026-01-01T00:00:00.000Z",
      })

      const endedState = endTaskTimer(TEST_DIR, workId, "todo:1", "2026-01-01T00:00:01.500Z")

      const taskSession = endedState?.works?.[workId]?.task_sessions?.["todo:1"]
      expect(taskSession?.ended_at).toBe("2026-01-01T00:00:01.500Z")
      expect(taskSession?.elapsed_ms).toBe(1500)
      expect(taskSession?.status).toBe("completed")
    })

    test("should complete one work and keep other work untouched", () => {
      const initialState = createBoulderState(join(TEST_DIR, ".sisyphus/plans/plan-a.md"), "session-a")
      writeBoulderState(TEST_DIR, initialState)
      const firstWorkId = Object.keys(initialState.works)[0]
      const withSecond = addBoulderWork(TEST_DIR, {
        planPath: join(TEST_DIR, ".sisyphus/plans/plan-b.md"),
        sessionId: "session-b",
      })
      const secondWorkId = Object.keys(withSecond!.works!).find((workId) => workId !== firstWorkId)!

      const completedState = completeBoulder(TEST_DIR, firstWorkId, "2026-01-01T01:00:00.000Z")

      expect(completedState?.works?.[firstWorkId]?.status).toBe("completed")
      expect(completedState?.works?.[firstWorkId]?.ended_at).toBe("2026-01-01T01:00:00.000Z")
      expect(completedState?.works?.[firstWorkId]?.elapsed_ms).toBe(
        Date.parse("2026-01-01T01:00:00.000Z") - Date.parse(completedState!.works![firstWorkId]!.started_at),
      )
      expect(completedState?.works?.[secondWorkId]?.status).not.toBe("completed")
      // v3: work files exist, not boulder.json
      expect(existsSync(join(BOULDER_SUBDIR, `${firstWorkId}.json`))).toBe(true)
      expect(existsSync(join(BOULDER_SUBDIR, `${secondWorkId}.json`))).toBe(true)
    })

    test("should keep first completion timing when completeBoulder is called repeatedly", () => {
      const initialState = createBoulderState(
        join(TEST_DIR, ".sisyphus/plans/plan-idempotent.md"),
        "session-a",
      )
      writeBoulderState(TEST_DIR, initialState)
      const workId = Object.keys(initialState.works)[0]

      const firstCompletedState = completeBoulder(TEST_DIR, workId, "2026-01-01T00:01:00Z")
      const secondCompletedState = completeBoulder(TEST_DIR, workId, "2026-01-01T01:00:00Z")

      expect(firstCompletedState?.works?.[workId]?.ended_at).toBe("2026-01-01T00:01:00Z")
      expect(secondCompletedState?.works?.[workId]?.ended_at).toBe("2026-01-01T00:01:00Z")
      expect(secondCompletedState?.works?.[workId]?.elapsed_ms).toBe(
        Date.parse("2026-01-01T00:01:00Z") - Date.parse(secondCompletedState!.works![workId]!.started_at),
      )
    })
  })

  // ─── readCurrentTopLevelTask ────────────────────────────────────

  describe("readCurrentTopLevelTask", () => {
    test("should return the first unchecked top-level task in TODOs", () => {
      const planPath = join(TEST_DIR, "current-task-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Finished task
  - [ ] nested acceptance checkbox
- [ ] 2. Current task

## Final Verification Wave
- [ ] F1. Final review
`)

      const result = readCurrentTopLevelTask(planPath)

      expect(result).not.toBeNull()
      expect(result?.key).toBe("todo:2")
      expect(result?.title).toBe("Current task")
    })

    test("should fall back to final-wave task when implementation tasks are complete", () => {
      const planPath = join(TEST_DIR, "final-wave-current-task-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Finished task

## Final Verification Wave
- [ ] F1. Final review
`)

      const result = readCurrentTopLevelTask(planPath)

      expect(result).not.toBeNull()
      expect(result?.key).toBe("final-wave:f1")
      expect(result?.title).toBe("Final review")
    })
  })

  // ─── getPlanProgress ────────────────────────────────────────────

  describe("getPlanProgress", () => {
    test("should count only top-level tasks under TODOs and Final Verification Wave sections", () => {
      const planPath = join(TEST_DIR, "test-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [ ] 1. Task 1
- [x] 2. Task 2
- [ ] 3. Task 3
- [X] 4. Task 4

## Final Verification Wave
- [ ] F1. Final review
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(5)
      expect(progress.completed).toBe(2)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore nested Acceptance Criteria checkboxes under TODOs (issue #3066)", () => {
      const planPath = join(TEST_DIR, "issue-3066-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Implement feature A

  **Acceptance Criteria**
  - [ ] criterion 1
  - [ ] criterion 2

- [x] 2. Implement feature B

  **Acceptance Criteria**
  - [ ] criterion 3
  - [ ] criterion 4

- [x] 3. Implement feature C
- [x] 4. Implement feature D
- [x] 5. Implement feature E
- [x] 6. Implement feature F
- [x] 7. Implement feature G
- [x] 8. Implement feature H
- [x] 9. Implement feature I

## Final Verification Wave
- [ ] F1. Final review
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(10)
      expect(progress.completed).toBe(9)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore checkboxes outside TODOs and Final Verification Wave sections", () => {
      const planPath = join(TEST_DIR, "ignore-other-sections-plan.md")
      writeFileSync(planPath, `# Plan

## Work Objectives

### Definition of Done
- [ ] Verifiable condition with command

## TODOs
- [x] 1. Real task one
- [ ] 2. Real task two

## Success Criteria

### Final Checklist
- [ ] All Must Have present
- [ ] All Must NOT Have absent
- [ ] All tests pass
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(2)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore indented checkboxes under top-level tasks", () => {
      const planPath = join(TEST_DIR, "nested-indented-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. top-level completed task
  - [ ] nested unchecked task
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(true)
    })

    test("should require proper task label format in TODOs", () => {
      const planPath = join(TEST_DIR, "malformed-labels-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [ ] no number prefix
- [x] 1. Valid numbered task
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(true)
    })

    test("should require F-prefix label format in Final Verification Wave", () => {
      const planPath = join(TEST_DIR, "malformed-final-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Implementation done

## Final Verification Wave
- [ ] missing F-prefix
- [ ] F1. Proper final review
- [x] F2. Another final review
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(3)
      expect(progress.completed).toBe(2)
      expect(progress.isComplete).toBe(false)
    })

    test("should return isComplete true when all top-level tasks checked", () => {
      const planPath = join(TEST_DIR, "complete-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Task 1
- [X] 2. Task 2

## Final Verification Wave
- [x] F1. Final review
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(3)
      expect(progress.completed).toBe(3)
      expect(progress.isComplete).toBe(true)
    })

    test("should return isComplete false for empty plan", () => {
      const planPath = join(TEST_DIR, "empty-plan.md")
      writeFileSync(planPath, "# Plan\nNo tasks here")

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should handle non-existent file", () => {
      const progress = getPlanProgress("/non/existent/file.md")
      expect(progress.total).toBe(0)
      expect(progress.completed).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should support asterisk bullet top-level tasks", () => {
      const planPath = join(TEST_DIR, "asterisk-bullet-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
* [x] 1. Task using asterisk bullet
* [ ] 2. Another asterisk task
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(2)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(false)
    })

    test("should count only top-level checkboxes for simple plans with nested tasks", () => {
      const planPath = join(TEST_DIR, "simple-nested-plan.md")
      writeFileSync(planPath, `# Plan

- [ ] Top-level task 1
  - [x] Nested task ignored
- [x] Top-level task 2
    * [ ] Another nested task ignored
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(2)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(false)
    })

    test("should treat final-wave-only plans as structured mode", () => {
      const planPath = join(TEST_DIR, "final-wave-only-plan.md")
      writeFileSync(planPath, `# Plan

## Final Verification Wave
- [ ] F1. Top-level final review
  - [x] Nested verification detail ignored
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore mixed indentation levels in simple plans", () => {
      const planPath = join(TEST_DIR, "simple-mixed-indentation-plan.md")
      writeFileSync(planPath, `# Plan

* [x] Top-level star task
 - [ ] Indented task ignored
	- [x] Tab-indented task ignored
- [ ] Top-level dash task
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(2)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(false)
    })
  })

  // ─── createBoulderState ─────────────────────────────────────────

  describe("createBoulderState", () => {
    test("should create v3 state with correct work fields", () => {
      const planPath = "/path/to/auth-refactor.md"
      const sessionId = "ses-abc123"

      const state = createBoulderState(planPath, sessionId)

      expect(state.schema_version).toBe(3)
      const w = firstWork(state)
      expect(w?.active_plan).toBe(planPath)
      expect(w?.session_ids).toEqual([sessionId])
      expect(w?.plan_name).toBe("auth-refactor")
      expect(w?.started_at).toBeDefined()
    })

    test("should include agent field on work when provided", () => {
      const planPath = "/path/to/feature.md"
      const sessionId = "ses-xyz789"
      const agent = "atlas"

      const state = createBoulderState(planPath, sessionId, agent)

      const w = firstWork(state)
      expect(w?.agent).toBe("atlas")
      expect(w?.active_plan).toBe(planPath)
      expect(w?.session_ids).toEqual([sessionId])
      expect(w?.plan_name).toBe("feature")
    })

    test("should mark the initial session origin as direct", () => {
      const planPath = "/path/to/feature.md"
      const sessionId = "ses-origin"

      const state = createBoulderState(planPath, sessionId)

      const w = firstWork(state)
      expect(w?.session_origins).toEqual({ [sessionId]: "direct" })
    })

    test("should allow agent to be undefined", () => {
      const planPath = "/path/to/legacy.md"
      const sessionId = "ses-legacy"

      const state = createBoulderState(planPath, sessionId)

      const w = firstWork(state)
      expect(w?.agent).toBeUndefined()
    })
  })

  // ─── resolveBoulderPlanPath ─────────────────────────────────────

  describe("resolveBoulderPlanPath", () => {
    test("should prefer the work-level worktree plan when it exists", () => {
      const planPath = join(TEST_DIR, ".sisyphus", "plans", "worktree-plan.md")
      const worktreeDir = join(tmpdir(), `boulder-state-worktree-${Date.now()}`)
      const worktreePlanPath = join(worktreeDir, ".sisyphus", "plans", "worktree-plan.md")
      mkdirSync(dirname(planPath), { recursive: true })
      mkdirSync(dirname(worktreePlanPath), { recursive: true })
      writeFileSync(planPath, "# Plan\n- [ ] Main repo task\n")
      writeFileSync(worktreePlanPath, "# Plan\n- [x] Worktree task\n")

      try {
        const resolvedPath = resolveBoulderPlanPath(TEST_DIR, {
          active_plan: planPath,
          worktree_path: worktreeDir,
        })

        expect(resolvedPath).toBe(worktreePlanPath)
      } finally {
        rmSync(worktreeDir, { recursive: true, force: true })
      }
    })

    test("should fall back to the tracked plan when the worktree plan is missing", () => {
      const planPath = join(TEST_DIR, ".sisyphus", "plans", "fallback-plan.md")
      mkdirSync(dirname(planPath), { recursive: true })
      writeFileSync(planPath, "# Plan\n- [ ] Main repo task\n")

      const resolvedPath = resolveBoulderPlanPath(TEST_DIR, {
        active_plan: planPath,
        worktree_path: join(tmpdir(), `missing-worktree-${Date.now()}`),
      })

      expect(resolvedPath).toBe(planPath)
    })
  })
})
