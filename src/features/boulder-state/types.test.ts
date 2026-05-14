import { describe, expect, test } from "bun:test"
import type {
  BoulderIndex,
  BoulderSessionOrigin,
  BoulderState,
  BoulderStateV2,
  BoulderTaskStatus,
  BoulderWorkResumeOption,
  BoulderWorkState,
  BoulderWorkStatus,
  PlanProgress,
  TaskSessionState,
} from "./types"

describe("boulder-state types", () => {
  test("keeps legacy BoulderStateV2 assignable while allowing v2 fields", () => {
    // given
    const legacyState: BoulderStateV2 = {
      active_plan: "/tmp/plan.md",
      started_at: "2026-01-01T00:00:00.000Z",
      session_ids: ["ses_1"],
      plan_name: "plan",
    }

    // when
    const hasLegacyShape = legacyState.active_plan.length > 0

    // then
    expect(hasLegacyShape).toBe(true)
  })

  test("v3 BoulderState is a pure container with no mirror fields", () => {
    // given
    const work: BoulderWorkState = {
      work_id: "plan-abc12345",
      active_plan: "/tmp/plan.md",
      plan_name: "plan",
      status: "active",
      started_at: "2026-01-01T00:00:00.000Z",
      session_ids: ["ses_1"],
    }

    const state: BoulderState = {
      schema_version: 3,
      works: { "plan-abc12345": work },
    }

    // then — v3 BoulderState has NO mirror fields
    expect(state.schema_version).toBe(3)
    expect(state.works["plan-abc12345"].plan_name).toBe("plan")
    // @ts-expect-error — active_plan should not exist on v3 BoulderState
    expect((state as any).active_plan).toBeUndefined()
    // @ts-expect-error — plan_name should not exist on v3 BoulderState
    expect((state as any).plan_name).toBeUndefined()
    // @ts-expect-error — status should not exist on v3 BoulderState
    expect((state as any).status).toBeUndefined()
    // @ts-expect-error — session_ids should not exist on v3 BoulderState
    expect((state as any).session_ids).toBeUndefined()
  })

  test("v3 BoulderIndex maps sessions to work IDs", () => {
    // given
    const index: BoulderIndex = {
      schema_version: 3,
      sessions: {
        ses_abc: "plan-abc12345",
        ses_def: "other-6789abcd",
      },
    }

    // then
    expect(index.schema_version).toBe(3)
    expect(index.sessions["ses_abc"]).toBe("plan-abc12345")
    expect(Object.keys(index.sessions)).toHaveLength(2)
  })

  test("supports multi-work and timer fields", () => {
    // given
    const taskStatus: BoulderTaskStatus = "running"
    const workStatus: BoulderWorkStatus = "active"
    const origin: BoulderSessionOrigin = "direct"

    const taskSession: TaskSessionState = {
      task_key: "todo:1",
      task_label: "1",
      task_title: "Do work",
      session_id: "ses_task",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:00:01.000Z",
      elapsed_ms: 1000,
      status: taskStatus,
      updated_at: "2026-01-01T00:00:01.000Z",
    }

    const work: BoulderWorkState = {
      work_id: "plan-abc12345",
      active_plan: "/tmp/plan.md",
      plan_name: "plan",
      status: workStatus,
      started_at: "2026-01-01T00:00:00.000Z",
      session_ids: ["ses_1"],
      session_origins: { ses_1: origin },
      task_sessions: { "todo:1": taskSession },
    }

    const progress: PlanProgress = { total: 2, completed: 1, isComplete: false }
    const resumeOption: BoulderWorkResumeOption = {
      work_id: work.work_id,
      plan_name: work.plan_name,
      active_plan: work.active_plan,
      status: "paused",
      started_at: work.started_at,
      updated_at: "2026-01-01T00:00:02.000Z",
      session_count: 1,
      progress,
      is_current_mirror: false,
    }

    // when
    const combined = { taskSession, work, resumeOption }

    // then
    expect(combined.resumeOption.progress.total).toBe(2)
  })
})
