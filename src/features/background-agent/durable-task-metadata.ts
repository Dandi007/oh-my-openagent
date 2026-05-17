import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { BackgroundTask, BackgroundTaskStatus } from "./types"

const DURABLE_TASK_METADATA_PATH = join(".sisyphus", "background-tasks.json")

export interface DurableTaskMetadata {
  id: string
  sessionId: string
  status: BackgroundTaskStatus
  description: string
  agent: string
  category?: string
  parentSessionId?: string
  parentMessageId?: string
  startedAt?: Date
  completedAt?: Date
  error?: string
}

type SerializedDurableTaskMetadata = Omit<DurableTaskMetadata, "startedAt" | "completedAt"> & {
  startedAt?: string
  completedAt?: string
}

type DurableTaskMetadataFile = {
  schemaVersion: 1
  tasks: Record<string, SerializedDurableTaskMetadata>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function serializeMetadata(metadata: DurableTaskMetadata): SerializedDurableTaskMetadata {
  return {
    id: metadata.id,
    sessionId: metadata.sessionId,
    status: metadata.status,
    description: metadata.description,
    agent: metadata.agent,
    ...(metadata.category ? { category: metadata.category } : {}),
    ...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
    ...(metadata.parentMessageId ? { parentMessageId: metadata.parentMessageId } : {}),
    ...(metadata.startedAt ? { startedAt: metadata.startedAt.toISOString() } : {}),
    ...(metadata.completedAt ? { completedAt: metadata.completedAt.toISOString() } : {}),
    ...(metadata.error ? { error: metadata.error } : {}),
  }
}

function parseMetadata(value: unknown): DurableTaskMetadata | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const status = value.status
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "completed" &&
    status !== "error" &&
    status !== "cancelled" &&
    status !== "interrupt"
  ) {
    return undefined
  }

  if (typeof value.id !== "string" || typeof value.sessionId !== "string" || typeof value.description !== "string" || typeof value.agent !== "string") {
    return undefined
  }

  return {
    id: value.id,
    sessionId: value.sessionId,
    status,
    description: value.description,
    agent: value.agent,
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    ...(typeof value.parentSessionId === "string" ? { parentSessionId: value.parentSessionId } : {}),
    ...(typeof value.parentMessageId === "string" ? { parentMessageId: value.parentMessageId } : {}),
    ...(parseDate(value.startedAt) ? { startedAt: parseDate(value.startedAt) } : {}),
    ...(parseDate(value.completedAt) ? { completedAt: parseDate(value.completedAt) } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  }
}

function readMetadataFile(filePath: string): Map<string, DurableTaskMetadata> {
  if (!existsSync(filePath)) {
    return new Map()
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"))
    if (!isRecord(parsed) || !isRecord(parsed.tasks)) {
      return new Map()
    }

    const entries = new Map<string, DurableTaskMetadata>()
    for (const [id, value] of Object.entries(parsed.tasks)) {
      const metadata = parseMetadata(value)
      if (metadata && metadata.id === id) {
        entries.set(id, metadata)
      }
    }
    return entries
  } catch {
    return new Map()
  }
}

function atomicWriteJson(filePath: string, data: DurableTaskMetadataFile): boolean {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8")
    renameSync(tmpPath, filePath)
    return true
  } catch (error) {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath)
    }
    return false
  }
}

export class DurableTaskMetadataStore {
  private entries: Map<string, DurableTaskMetadata>
  private readonly filePath?: string

  constructor(directory?: string) {
    this.filePath = directory ? join(directory, DURABLE_TASK_METADATA_PATH) : undefined
    this.entries = this.filePath ? readMetadataFile(this.filePath) : new Map()
  }

  set(id: string, metadata: DurableTaskMetadata): void {
    this.entries.set(id, metadata)
    this.persist()
  }

  get(id: string): DurableTaskMetadata | undefined {
    return this.entries.get(id)
  }

  delete(id: string): void {
    this.entries.delete(id)
    this.persist()
  }

  clear(): void {
    this.entries.clear()
    this.persist()
  }

  toBackgroundTask(metadata: DurableTaskMetadata): BackgroundTask {
    return {
      id: metadata.id,
      sessionId: metadata.sessionId,
      parentSessionId: metadata.parentSessionId ?? "",
      parentMessageId: metadata.parentMessageId ?? "",
      description: metadata.description,
      prompt: "",
      agent: metadata.agent,
      status: metadata.status,
      category: metadata.category,
      startedAt: metadata.startedAt,
      completedAt: metadata.completedAt,
      error: metadata.error,
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return
    }

    const tasks: Record<string, SerializedDurableTaskMetadata> = {}
    for (const [id, metadata] of this.entries.entries()) {
      tasks[id] = serializeMetadata(metadata)
    }
    atomicWriteJson(this.filePath, { schemaVersion: 1, tasks })
  }
}
