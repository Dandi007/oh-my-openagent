/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DurableTaskMetadataStore } from "./durable-task-metadata"

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-durable-task-metadata-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe("DurableTaskMetadataStore", () => {
  test("reloads task metadata from disk for a new store instance", () => {
    // #given
    const directory = createTempDir()
    const firstStore = new DurableTaskMetadataStore(directory)
    firstStore.set("bg_reloaded", {
      id: "bg_reloaded",
      sessionId: "ses-reloaded",
      status: "completed",
      description: "reloaded task",
      agent: "test-agent",
      category: "quick",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      completedAt: new Date("2026-01-01T00:01:00Z"),
    })

    // #when
    const secondStore = new DurableTaskMetadataStore(directory)
    const task = secondStore.toBackgroundTask(secondStore.get("bg_reloaded")!)

    // #then
    expect(task.id).toBe("bg_reloaded")
    expect(task.sessionId).toBe("ses-reloaded")
    expect(task.status).toBe("completed")
    expect(task.description).toBe("reloaded task")
    expect(task.category).toBe("quick")
    expect(task.startedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(task.completedAt?.toISOString()).toBe("2026-01-01T00:01:00.000Z")
  })
})
