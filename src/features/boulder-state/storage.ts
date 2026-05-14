/**
 * Boulder State Storage — v3
 *
 * v3 storage layout:
 *   .sisyphus/boulder/{work_id}.json  — individual work state files
 *   .sisyphus/boulder/index.json       — session→work lookup (derived cache)
 *   .sisyphus/boulder/.migrated        — v2→v3 migration marker
 *
 * v2 legacy (preserved for read compatibility):
 *   .sisyphus/boulder.json             — single-file boulder state
 *
 * All writes use .tmp + rename for atomicity.
 * The index is a derived cache — rebuildable from work files via rebuildIndexFromWorkFiles().
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import type {
  BoulderIndex,
  BoulderSessionOrigin,
  BoulderState,
  BoulderStateV2,
  BoulderWorkResumeOption,
  BoulderWorkState,
  BoulderWorkStatus,
  PlanProgress,
  TaskSessionState,
} from "./types"
import {
  BOULDER_DIR,
  BOULDER_INDEX_FILE,
  BOULDER_INDEX_PATH,
  BOULDER_MIGRATED_MARKER,
  BOULDER_MIGRATED_PATH,
  BOULDER_V2_BACKUP_SUFFIX,
  BOULDER_V2_STATE_PATH,
  BOULDER_V2_DIR,
  BOULDER_V2_FILE,
  PROMETHEUS_PLANS_DIR,
} from "./constants"

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"])

// ─── utilities ──────────────────────────────────────────────────────

function nowIsoString(): string {
  return new Date().toISOString()
}

function parseIsoToMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function getElapsedMs(startedAt: string | undefined, endedAt: string | undefined): number | undefined {
  const startedMs = parseIsoToMs(startedAt)
  const endedMs = parseIsoToMs(endedAt)
  if (startedMs === null || endedMs === null) return undefined
  return endedMs - startedMs
}

function isValidWorkStatus(status: unknown): status is BoulderWorkStatus {
  return status === "active" || status === "completed" || status === "paused" || status === "abandoned"
}

/**
 * Atomic JSON write: write to .tmp then rename.
 * rename(2) is atomic on APFS (macOS) and most POSIX filesystems.
 * Uses pid + random suffix to avoid collisions between concurrent writers.
 */
function atomicWriteJson(filePath: string, data: unknown): boolean {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8")
    renameSync(tmpPath, filePath)
    return true
  } catch {
    // Clean up orphaned .tmp if rename failed
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch { /* best effort */ }
    return false
  }
}

/**
 * Read and parse a JSON file. Returns null on any failure.
 */
function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as T
  } catch {
    return null
  }
}

// ─── v2 compatibility helpers ───────────────────────────────────────

function getPlanName(planPath: string): string {
  return basename(planPath, ".md")
}

/**
 * Build a BoulderWorkState from v2 mirror fields.
 * Used when reading legacy boulder.json that has no works registry.
 */
function buildWorkFromMirrorV2(state: BoulderStateV2): BoulderWorkState {
  const planName = state.plan_name ?? getPlanName(state.active_plan)
  const workId = `${planName}-legacy`
  return {
    work_id: workId,
    active_plan: state.active_plan,
    plan_name: planName,
    status: state.status,
    started_at: state.started_at,
    ended_at: state.ended_at,
    elapsed_ms: state.elapsed_ms,
    updated_at: state.updated_at,
    session_ids: Array.isArray(state.session_ids) ? [...state.session_ids] : [],
    session_origins: state.session_origins ? { ...state.session_origins } as Record<string, BoulderSessionOrigin> : {},
    agent: state.agent,
    worktree_path: state.worktree_path,
    task_sessions: state.task_sessions ? { ...state.task_sessions } : {},
  }
}

/**
 * Convert a v2 BoulderStateV2 (from boulder.json) into a v3 BoulderState.
 *
 * Handles both v2 formats:
 *   - Object works: `{ "work-id": { ... } }` (legacy)
 *   - Array works: `[ { "work_id": "...", ... } ]` (newer v2)
 *
 * For array works, inherits `active_plan` and `started_at` from v2 top-level
 * when the work object doesn't have them.
 *
 * Normalizes `session_origins` from object values to "direct"|"appended" strings.
 * Converts `task_sessions` from string arrays to TaskSessionState objects.
 */
function convertV2ToV3(v2: BoulderStateV2): BoulderState | null {
  const works: Record<string, BoulderWorkState> = {}

  if (v2.works && typeof v2.works === "object") {
    if (Array.isArray(v2.works)) {
      // Array format: each entry is a partial BoulderWorkState
      for (const entry of v2.works) {
        if (!entry || typeof entry !== "object" || typeof entry.work_id !== "string") continue
        const workId = entry.work_id

        // Inherit missing fields from v2 top-level
        const activePlan = typeof entry.active_plan === "string" ? entry.active_plan : v2.active_plan
        const startedAt = typeof entry.started_at === "string" ? entry.started_at : v2.started_at
        if (!activePlan || !startedAt) continue

        // Normalize session_origins: object values → "direct"
        const rawOrigins = entry.session_origins
        const sessionOrigins: Record<string, BoulderSessionOrigin> = {}
        if (rawOrigins && typeof rawOrigins === "object" && !Array.isArray(rawOrigins)) {
          for (const [sid, val] of Object.entries(rawOrigins)) {
            if (typeof val === "string" && (val === "direct" || val === "appended")) {
              sessionOrigins[sid] = val
            } else {
              sessionOrigins[sid] = "direct"
            }
          }
        }

        // Convert task_sessions: string arrays → TaskSessionState objects
        const rawTaskSessions = entry.task_sessions
        const taskSessions: Record<string, TaskSessionState> = {}
        if (rawTaskSessions && typeof rawTaskSessions === "object" && !Array.isArray(rawTaskSessions)) {
          for (const [taskKey, val] of Object.entries(rawTaskSessions)) {
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
              taskSessions[taskKey] = {
                task_key: taskKey,
                task_label: taskKey,
                task_title: taskKey,
                session_id: val[0],
                updated_at: startedAt,
              }
            } else if (val && typeof val === "object" && !Array.isArray(val)) {
              const validated = validateTaskSessionState(val as Record<string, unknown>)
              if (validated) {
                taskSessions[taskKey] = validated
              }
            }
          }
        }

        const sessionIds: string[] = Array.isArray(entry.session_ids)
          ? entry.session_ids.filter((s: unknown): s is string => typeof s === "string")
          : []

        works[workId] = {
          work_id: workId,
          active_plan: activePlan,
          plan_name: typeof entry.plan_name === "string" ? entry.plan_name : getPlanName(activePlan),
          status: isValidWorkStatus(entry.status) ? entry.status : undefined,
          started_at: startedAt,
          ended_at: typeof entry.ended_at === "string" ? entry.ended_at : undefined,
          elapsed_ms: typeof entry.elapsed_ms === "number" ? entry.elapsed_ms : undefined,
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : startedAt,
          session_ids: sessionIds,
          session_origins: Object.keys(sessionOrigins).length > 0 ? sessionOrigins : undefined,
          agent: typeof entry.agent === "string" ? entry.agent : undefined,
          worktree_path: typeof entry.worktree_path === "string" ? entry.worktree_path : undefined,
          task_sessions: Object.keys(taskSessions).length > 0 ? taskSessions : undefined,
        }
      }
    } else {
      // Object format: keyed by work_id
      for (const [id, work] of Object.entries(v2.works)) {
        if (work && typeof work === "object") {
          const validated = validateBoulderWorkState(work as unknown as Record<string, unknown>)
          if (validated) {
            works[id] = validated
          }
        }
      }
    }
  }

  // If no works were extracted, build one from mirror fields
  if (Object.keys(works).length === 0 && v2.active_plan && v2.plan_name && v2.started_at) {
    const mirrorWork = buildWorkFromMirrorV2(v2)
    works[mirrorWork.work_id] = mirrorWork
  }

  // If still no works, the v2 state is effectively empty
  if (Object.keys(works).length === 0) return null

  return {
    schema_version: 3,
    works,
  }
}

/**
 * Check if v2 boulder.json exists at the given directory.
 */
function v2StateExists(directory: string): boolean {
  return existsSync(join(directory, BOULDER_V2_STATE_PATH))
}

/**
 * Read v2 boulder.json and return as BoulderStateV2.
 */
function readV2StateRaw(directory: string): BoulderStateV2 | null {
  const filePath = join(directory, BOULDER_V2_STATE_PATH)
  const parsed = readJsonSafe<Record<string, unknown>>(filePath)
  if (!parsed) return null

  // Normalize v2 fields
  let sessionIds: unknown[] = Array.isArray(parsed.session_ids) ? parsed.session_ids as unknown[] : []
  if (!Array.isArray(parsed.session_ids)) {
    parsed.session_ids = []
  }
  if (!parsed.session_origins || typeof parsed.session_origins !== "object" || Array.isArray(parsed.session_origins)) {
    parsed.session_origins = {}
  }
  if (sessionIds.length === 1) {
    const soleSessionId = sessionIds[0]
    const origins = parsed.session_origins as Record<string, unknown>
    if (
      typeof soleSessionId === "string"
      && origins[soleSessionId] !== "appended"
      && origins[soleSessionId] !== "direct"
    ) {
      origins[soleSessionId] = "direct"
    }
  }
  if (!parsed.task_sessions || typeof parsed.task_sessions !== "object" || Array.isArray(parsed.task_sessions)) {
    parsed.task_sessions = {}
  }

  return parsed as unknown as BoulderStateV2
}

// ─── v2→v3 migration ────────────────────────────────────────────────

/**
 * Migrate v2 boulder.json to v3 multi-file storage.
 *
 * Steps (in order):
 *   1. Read v2 boulder.json
 *   2. Convert to v3 BoulderState
 *   3. Write each work file (skip already-existing for retry resilience)
 *   4. Build and atomically write index.json
 *   5. Write .migrated marker (BEFORE rename — if rename fails, v2 file is intact)
 *   6. Rename boulder.json → boulder.json.v2.bak
 *
 * Idempotency:
 *   If .migrated exists AND index.json is valid → skip (return true).
 *
 * Failure recovery:
 *   If steps 3-4 fail, already-written work files are NOT deleted.
 *   Next call restarts from step 1, skipping already-existing work files.
 *   .migrated is NOT written until ALL steps succeed.
 *
 * @returns true if migration succeeded or was already done, false on failure.
 */
export function migrateBoulderV2ToV3(directory: string): boolean {
  // ── Idempotency check ──
  const markerPath = join(directory, BOULDER_MIGRATED_PATH)
  if (existsSync(markerPath)) {
    const index = readBoulderIndex(directory)
    if (index !== null) return true // Already migrated successfully
    // Marker exists but index is invalid — re-migrate
  }

  // ── Step 1: Read v2 state ──
  if (!v2StateExists(directory)) return false
  const v2 = readV2StateRaw(directory)
  if (!v2) return false

  // ── Step 2: Convert to v3 ──
  const v3 = convertV2ToV3(v2)
  if (!v3) return false

  // ── Step 3: Write each work file (skip already-existing) ──
  for (const [workId, work] of Object.entries(v3.works)) {
    const workPath = join(directory, BOULDER_DIR, `${workId}.json`)
    if (existsSync(workPath)) continue // Already written from a previous partial run
    if (!writeBoulderWork(directory, workId, work)) return false
  }

  // ── Step 4: Build and atomically write index ──
  const index = rebuildIndexFromWorkFiles(directory)
  if (!writeBoulderIndex(directory, index)) return false

  // ── Step 5: Write migration marker FIRST (before rename) ──
  // If marker write succeeds but rename fails, the v2 file is still intact
  // and the marker prevents re-migration attempts.
  const markerDir = dirname(markerPath)
  if (!existsSync(markerDir)) {
    mkdirSync(markerDir, { recursive: true })
  }
  try {
    writeFileSync(markerPath, nowIsoString(), "utf-8")
  } catch {
    return false
  }

  // ── Step 6: Rename v2 file to backup ──
  const v2Path = join(directory, BOULDER_V2_STATE_PATH)
  const backupPath = v2Path + BOULDER_V2_BACKUP_SUFFIX
  try {
    renameSync(v2Path, backupPath)
  } catch {
    // Marker is already written — migration is considered done.
    // The v2 file remains in place but won't be re-migrated.
    return true
  }

  return true
}

// ─── v3 Tier 1: Work file I/O ───────────────────────────────────────

/**
 * Validate a parsed work object against the filename.
 * Returns the work if valid, null otherwise.
 */
function validateWorkFile(parsed: Record<string, unknown>, expectedWorkId: string): BoulderWorkState | null {
  if (typeof parsed.work_id !== "string" || parsed.work_id.length === 0) return null
  if (parsed.work_id !== expectedWorkId) return null
  if (typeof parsed.active_plan !== "string" || parsed.active_plan.length === 0) return null
  if (typeof parsed.plan_name !== "string" || parsed.plan_name.length === 0) return null
  if (typeof parsed.started_at !== "string" || parsed.started_at.length === 0) return null
  if (!Array.isArray(parsed.session_ids)) return null
  if (parsed.status !== undefined && !isValidWorkStatus(parsed.status)) return null
  return parsed as unknown as BoulderWorkState
}

/**
 * Validate a parsed object as a BoulderWorkState (without filename cross-check).
 * Used when reading from v2 works registry where work_id is the key.
 */
function validateBoulderWorkState(parsed: Record<string, unknown>): BoulderWorkState | null {
  if (typeof parsed.work_id !== "string" || parsed.work_id.length === 0) return null
  if (typeof parsed.active_plan !== "string" || parsed.active_plan.length === 0) return null
  if (typeof parsed.plan_name !== "string" || parsed.plan_name.length === 0) return null
  if (typeof parsed.started_at !== "string" || parsed.started_at.length === 0) return null
  if (!Array.isArray(parsed.session_ids)) return null
  if (parsed.status !== undefined && !isValidWorkStatus(parsed.status)) return null
  return parsed as unknown as BoulderWorkState
}

/**
 * Validate a parsed object as a TaskSessionState.
 * Requires at minimum: task_key, task_label, task_title, session_id, updated_at.
 */
function validateTaskSessionState(parsed: Record<string, unknown>): TaskSessionState | null {
  if (typeof parsed.task_key !== "string" || parsed.task_key.length === 0) return null
  if (typeof parsed.task_label !== "string") return null
  if (typeof parsed.task_title !== "string") return null
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) return null
  if (typeof parsed.updated_at !== "string" || parsed.updated_at.length === 0) return null
  return parsed as unknown as TaskSessionState
}

/**
 * Read a single work file by work_id.
 *
 * @returns BoulderWorkState if file exists and is valid, null otherwise.
 */
export function readBoulderWork(directory: string, workId: string): BoulderWorkState | null {
  const filePath = join(directory, BOULDER_DIR, `${workId}.json`)
  const parsed = readJsonSafe<Record<string, unknown>>(filePath)
  if (!parsed) return null
  return validateWorkFile(parsed, workId)
}

/**
 * Write a single work file atomically.
 *
 * @returns true on success, false on failure.
 */
export function writeBoulderWork(directory: string, workId: string, work: BoulderWorkState): boolean {
  const sessionOriginsMissing = work.session_ids.length > 0
    && (!work.session_origins || Object.keys(work.session_origins).length === 0)
  if (sessionOriginsMissing) {
    console.warn(
      `[boulder-state] writeBoulderWork: work "${workId}" has ${work.session_ids.length} session(s) but empty session_origins`,
    )
  }
  const filePath = join(directory, BOULDER_DIR, `${workId}.json`)
  return atomicWriteJson(filePath, work)
}

/**
 * List all work IDs from the boulder directory.
 * Excludes index.json and non-.json files.
 *
 * @returns Array of work_id strings (without .json extension).
 */
export function listBoulderWorkIds(directory: string): string[] {
  const boulderDir = join(directory, BOULDER_DIR)
  if (!existsSync(boulderDir)) return []

  try {
    return readdirSync(boulderDir)
      .filter((f) => f.endsWith(".json") && f !== BOULDER_INDEX_FILE && !f.startsWith("."))
      .map((f) => f.replace(/\.json$/, ""))
  } catch {
    return []
  }
}

// ─── v3 Tier 2: Index I/O ──────────────────────────────────────────

/**
 * Read the session→work index.
 *
 * @returns BoulderIndex if file exists and is valid, null otherwise.
 */
export function readBoulderIndex(directory: string): BoulderIndex | null {
  const filePath = join(directory, BOULDER_INDEX_PATH)
  const parsed = readJsonSafe<Record<string, unknown>>(filePath)
  if (!parsed) return null
  if (parsed.schema_version !== 3) return null
  if (!parsed.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) return null

  // Validate all entries are string→string
  const sessions = parsed.sessions as Record<string, unknown>
  for (const [key, value] of Object.entries(sessions)) {
    if (typeof key !== "string" || typeof value !== "string") return null
  }

  return { schema_version: 3, sessions: sessions as Record<string, string> }
}

/**
 * Write the session→work index atomically.
 *
 * @returns true on success, false on failure.
 */
export function writeBoulderIndex(directory: string, index: BoulderIndex): boolean {
  const filePath = join(directory, BOULDER_INDEX_PATH)
  return atomicWriteJson(filePath, index)
}

/**
 * Rebuild the index from all work files.
 *
 * Scans all .json files in BOULDER_DIR (excluding index.json),
 * extracts session_ids from each work, and builds the session→work mapping.
 *
 * Handles:
 * - Missing boulder directory → returns empty index
 * - Empty directory → returns empty index
 * - Corrupt work files → skips them
 * - Duplicate session IDs → last work processed wins
 *
 * @returns A complete BoulderIndex rebuilt from work files.
 */
export function rebuildIndexFromWorkFiles(directory: string): BoulderIndex {
  const sessions: Record<string, string> = {}
  const workIds = listBoulderWorkIds(directory)

  // Read all works and sort by updated_at ascending so later entries
  // (more recently updated) overwrite earlier ones for duplicate sessions.
  const works = workIds
    .map((id) => readBoulderWork(directory, id))
    .filter((w): w is BoulderWorkState => w !== null)
    .sort((a, b) => {
      const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
      const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
      return aMs - bMs // ascending: older first, newer last (wins)
    })

  for (const work of works) {
    for (const sid of work.session_ids) {
      sessions[sid] = work.work_id
    }
  }

  return { schema_version: 3, sessions }
}

// ─── v3 Tier 3: Aggregate operations ───────────────────────────────

/**
 * Read the full boulder state.
 *
 * v3 path: reads index + all work files, returns v3 BoulderState.
 * v2 fallback: if v3 files don't exist but v2 boulder.json does,
 *   reads v2 and converts to v3 BoulderState (migration trigger is Task 4).
 *
 * @returns BoulderState (v3 pure container) or null if no state exists.
 */
export function readBoulderState(directory: string): BoulderState | null {
  // Try v3 first
  const boulderDir = join(directory, BOULDER_DIR)
  if (existsSync(boulderDir)) {
    const workIds = listBoulderWorkIds(directory)
    const works: Record<string, BoulderWorkState> = {}
    for (const workId of workIds) {
      const work = readBoulderWork(directory, workId)
      if (work) {
        works[workId] = work
      }
    }
    if (Object.keys(works).length > 0) {
      // Auto-rebuild index if missing (agent apply_patch may bypass writeBoulderState)
      const index = readBoulderIndex(directory)
      if (!index) {
        const rebuilt = rebuildIndexFromWorkFiles(directory)
        writeBoulderIndex(directory, rebuilt)
      }
      return { schema_version: 3, works }
    }
    // v3 dir exists but no valid work files — fall through to try v2
  }

  // Try v2 fallback — auto-migrate if needed
  if (v2StateExists(directory)) {
    const markerPath = join(directory, BOULDER_MIGRATED_PATH)
    if (!existsSync(markerPath)) {
      // Auto-migrate v2 → v3
      if (migrateBoulderV2ToV3(directory)) {
        // Re-read from v3 after successful migration
        return readBoulderState(directory)
      }
    }
    // Migration already done or failed — read v2 directly as fallback
    const v2 = readV2StateRaw(directory)
    if (v2) {
      return convertV2ToV3(v2)
    }
  }

  return null
}

/**
 * Write the full boulder state to v3 storage.
 *
 * Writes each work to its own file, then builds and writes the index.
 * No more mirror sync — BoulderState is a pure container.
 *
 * @returns true on success, false on failure.
 */
export function writeBoulderState(directory: string, state: BoulderState): boolean {
  if (!state?.works || typeof state.works !== "object") return false

  // Write each work file
  for (const [workId, work] of Object.entries(state.works)) {
    if (!writeBoulderWork(directory, workId, work)) {
      return false
    }
  }

  // Build and write index
  const index = rebuildIndexFromWorkFiles(directory)
  if (!writeBoulderIndex(directory, index)) {
    return false
  }

  return true
}

/**
 * Get all works from a BoulderState.
 * In v3, this is simply Object.values(state.works).
 */
export function getBoulderWorks(state: BoulderState): BoulderWorkState[] {
  if (!state || !state.works || typeof state.works !== "object") {
    return []
  }
  return Object.values(state.works)
}

/**
 * List all known works from disk, sorted by updated_at descending.
 */
export function listBoulderWorks(directory: string): BoulderWorkState[] {
  const workIds = listBoulderWorkIds(directory)
  const works: BoulderWorkState[] = []

  for (const workId of workIds) {
    const work = readBoulderWork(directory, workId)
    if (work) works.push(work)
  }

  works.sort((a, b) => {
    const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
    const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
    return bMs - aMs
  })

  return works
}

function repairSessionOriginsIfNeeded(directory: string, work: BoulderWorkState): BoulderWorkState {
  if (work.session_ids.length === 0) return work
  if (work.session_origins && Object.keys(work.session_origins).length > 0) return work

  const repairedOrigins: Record<string, BoulderSessionOrigin> = {}
  for (const sid of work.session_ids) {
    repairedOrigins[sid] = "direct"
  }
  const repaired: BoulderWorkState = {
    ...work,
    session_origins: repairedOrigins,
  }
  writeBoulderWork(directory, work.work_id, repaired)
  return repaired
}

/**
 * Find which work a session belongs to.
 *
 * Uses index for O(1) lookup. Falls back to scanning all work files
 * if the index is missing or doesn't contain the session.
 *
 * @returns The BoulderWorkState containing the session, or null.
 */
export function getWorkForSession(directory: string, sessionId: string): BoulderWorkState | null {
  // Try index first (O(1))
  const index = readBoulderIndex(directory)
  if (index) {
    const workId = index.sessions[sessionId]
    if (workId) {
      const work = readBoulderWork(directory, workId)
      if (work) return repairSessionOriginsIfNeeded(directory, work)
      // Stale index entry — work file missing, fall through to scan
    }
  }

  // Fallback: scan all work files (O(n))
  const works = listBoulderWorks(directory)
    .filter((work) => work.session_ids.includes(sessionId))
    .sort((a, b) => {
      const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
      const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
      return bMs - aMs
    })

  const found = works[0] ?? null
  if (!found) return null

  if (!index && works.length > 0) {
    const rebuilt = rebuildIndexFromWorkFiles(directory)
    writeBoulderIndex(directory, rebuilt)
  }

  return repairSessionOriginsIfNeeded(directory, found)
}

/**
 * Find which work a session belongs to — strict mode.
 *
 * Like getWorkForSession() but returns a structured result that distinguishes
 * between "no work found" and "index points to missing work file".
 *
 * @returns { work, error } where exactly one is non-null.
 */
export function getWorkForSessionStrict(
  directory: string,
  sessionId: string,
): { work: BoulderWorkState | null; error: string | null } {
  // Try index first (O(1))
  const index = readBoulderIndex(directory)
  if (index) {
    const workId = index.sessions[sessionId]
    if (workId) {
      const work = readBoulderWork(directory, workId)
      if (work) return { work: repairSessionOriginsIfNeeded(directory, work), error: null }
      // Stale index entry — work file missing
      return {
        work: null,
        error: `Index points to work "${workId}" for session "${sessionId}" but the work file is missing. Run rebuildIndexFromWorkFiles() to repair.`,
      }
    }
  }

  // Fallback: scan all work files (O(n))
  const works = listBoulderWorks(directory)
    .filter((work) => work.session_ids.includes(sessionId))
    .sort((a, b) => {
      const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
      const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
      return bMs - aMs
    })

  if (works[0]) return { work: repairSessionOriginsIfNeeded(directory, works[0]), error: null }
  return { work: null, error: null }
}

// ─── path resolution ───────────────────────────────────────────────

/** @deprecated Use BOULDER_DIR + work_id for v3 paths */
export function getBoulderFilePath(directory: string): string {
  return join(directory, BOULDER_V2_DIR, BOULDER_V2_FILE)
}

function resolveTrackedPath(baseDirectory: string, trackedPath: string | undefined): string {
  if (!trackedPath) return resolve(baseDirectory)
  return isAbsolute(trackedPath)
    ? resolve(trackedPath)
    : resolve(baseDirectory, trackedPath)
}

/**
 * Resolve the absolute plan path, preferring the worktree copy if it exists.
 *
 * In v3, callers should pass work-level fields (active_plan, worktree_path)
 * extracted from a BoulderWorkState.
 */
export function resolveBoulderPlanPath(
  directory: string,
  state: Pick<BoulderWorkState, "active_plan" | "worktree_path">,
): string {
  const absolutePlanPath = resolveTrackedPath(directory, state.active_plan)
  const worktreePath = state.worktree_path?.trim()
  if (!worktreePath) {
    return absolutePlanPath
  }

  const absoluteDirectory = resolve(directory)
  const relativePlanPath = relative(absoluteDirectory, absolutePlanPath)
  if (
    relativePlanPath.length === 0
    || relativePlanPath.startsWith("..")
    || isAbsolute(relativePlanPath)
  ) {
    return absolutePlanPath
  }

  const absoluteWorktreePath = resolveTrackedPath(directory, worktreePath)
  const worktreePlanPath = resolve(absoluteWorktreePath, relativePlanPath)
  return existsSync(worktreePlanPath)
    ? worktreePlanPath
    : absolutePlanPath
}

export function resolveBoulderPlanPathForWork(
  directory: string,
  work: Pick<BoulderWorkState, "active_plan" | "worktree_path">,
): string {
  return resolveBoulderPlanPath(directory, work)
}

// ─── session management ────────────────────────────────────────────

/**
 * Append a session ID to the active work.
 *
 * In v3: updates the work file and rebuilds the index.
 */
export function appendSessionId(
  directory: string,
  sessionId: string,
  origin: "direct" | "appended" = "direct",
): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  // Find the most recently updated active work
  const activeWorks = getBoulderWorks(state)
    .filter((w) => w.status !== "completed" && w.status !== "abandoned")
    .sort((a, b) => {
      const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
      const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
      return bMs - aMs
    })

  if (activeWorks.length > 0) {
    return appendSessionIdForWork(directory, activeWorks[0].work_id, sessionId, origin)
  }

  // No active works — append to the first work found
  const allWorks = getBoulderWorks(state)
  if (allWorks.length > 0) {
    return appendSessionIdForWork(directory, allWorks[0].work_id, sessionId, origin)
  }

  return null
}

/**
 * Append a session ID to a specific work.
 *
 * In v3: updates the work file, then rebuilds and writes the index.
 */
export function appendSessionIdForWork(
  directory: string,
  workId: string,
  sessionId: string,
  origin: BoulderSessionOrigin = "direct",
): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  const targetWork = state.works[workId]
  if (!targetWork) return null

  const sessionIds = targetWork.session_ids.includes(sessionId)
    ? [...targetWork.session_ids]
    : [...targetWork.session_ids, sessionId]
  const sessionOrigins: Record<string, BoulderSessionOrigin> = {
    ...(targetWork.session_origins ?? {}),
    [sessionId]: origin,
  }

  const updatedWork: BoulderWorkState = {
    ...targetWork,
    session_ids: sessionIds,
    session_origins: sessionOrigins,
    updated_at: nowIsoString(),
  }

  // Write work file first, then index
  if (!writeBoulderWork(directory, workId, updatedWork)) {
    return null
  }

  const index = rebuildIndexFromWorkFiles(directory)
  writeBoulderIndex(directory, index) // best-effort; index is rebuildable

  return {
    schema_version: 3,
    works: { ...state.works, [workId]: updatedWork },
  }
}

// ─── work lifecycle ────────────────────────────────────────────────

export function generateWorkId(planName: string): string {
  const slug = planName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const randomHex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0")
  const safeSlug = slug.length > 0 ? slug : "work"
  return `${safeSlug}-${randomHex}`
}

/**
 * Create a new v3 boulder state for a plan.
 *
 * Returns a pure v3 BoulderState with a single work entry.
 */
export function createBoulderState(
  planPath: string,
  sessionId: string,
  agent?: string,
  worktreePath?: string,
): BoulderState {
  const startedAt = nowIsoString()
  const workId = generateWorkId(getPlanName(planPath))
  const work: BoulderWorkState = {
    work_id: workId,
    active_plan: planPath,
    plan_name: getPlanName(planPath),
    status: "active",
    started_at: startedAt,
    updated_at: startedAt,
    session_ids: [sessionId],
    session_origins: {
      [sessionId]: "direct",
    },
    ...(agent !== undefined ? { agent } : {}),
    ...(worktreePath !== undefined ? { worktree_path: worktreePath } : {}),
    task_sessions: {},
  }

  return {
    schema_version: 3,
    works: { [workId]: work },
  }
}

export function getActiveWorks(directory: string): BoulderWorkState[] {
  const state = readBoulderState(directory)
  if (!state) return []
  return getBoulderWorks(state).filter((work) => work.status !== "completed" && work.status !== "abandoned")
}

export function getWorkById(directory: string, workId: string): BoulderWorkState | null {
  return readBoulderWork(directory, workId)
}

export function getWorkByPlanName(
  directory: string,
  planName: string,
  options?: { worktreePath?: string },
): BoulderWorkState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  const worktreePath = options?.worktreePath
  return getBoulderWorks(state).find((work) => {
    if (work.plan_name !== planName) return false
    if (!worktreePath) return true
    return work.worktree_path === worktreePath
  }) ?? null
}

export function getWorkResumeOptions(directory: string): BoulderWorkResumeOption[] {
  return getActiveWorks(directory).map((work) => {
    const progress = getPlanProgress(resolveBoulderPlanPathForWork(directory, work))
    return {
      work_id: work.work_id,
      plan_name: work.plan_name,
      active_plan: work.active_plan,
      worktree_path: work.worktree_path,
      status: work.status && isValidWorkStatus(work.status) ? work.status : "active",
      started_at: work.started_at,
      updated_at: work.updated_at ?? work.started_at,
      ended_at: work.ended_at,
      elapsed_ms: work.elapsed_ms,
      session_count: work.session_ids.length,
      progress,
      is_current_mirror: false, // v3 has no mirror concept
    }
  })
}

export function selectActiveWork(directory: string, workId: string): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  const work = state.works[workId]
  if (!work) return null

  // In v3, "selecting" a work just means it exists — no mirror to update.
  // We write the state to ensure the work file is persisted.
  if (!writeBoulderState(directory, state)) return null

  return state
}

export function addBoulderWork(
  directory: string,
  input: {
    planPath: string
    sessionId: string
    agent?: string
    worktreePath?: string
    startedAt?: string
  },
): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  const workId = generateWorkId(getPlanName(input.planPath))
  const startedAt = input.startedAt ?? nowIsoString()
  const nextWork: BoulderWorkState = {
    work_id: workId,
    active_plan: input.planPath,
    plan_name: getPlanName(input.planPath),
    status: "active",
    started_at: startedAt,
    updated_at: startedAt,
    session_ids: [input.sessionId],
    session_origins: {
      [input.sessionId]: "direct",
    },
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.worktreePath !== undefined ? { worktree_path: input.worktreePath } : {}),
    task_sessions: {},
  }

  const nextState: BoulderState = {
    schema_version: 3,
    works: { ...state.works, [workId]: nextWork },
  }

  if (!writeBoulderState(directory, nextState)) return null

  return nextState
}

// ─── task session management ───────────────────────────────────────

export function getTaskSessionState(directory: string, taskKey: string): TaskSessionState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  // Check all works for the task session
  for (const work of Object.values(state.works)) {
    const taskSession = work.task_sessions?.[taskKey]
    if (taskSession) return taskSession
  }

  return null
}

/**
 * Get task session state scoped to a specific work.
 *
 * Unlike getTaskSessionState() which scans ALL works (cross-work pollution risk),
 * this function only looks up the task session within the specified work.
 *
 * @returns TaskSessionState if found in the specified work, null otherwise.
 */
export function getTaskSessionStateForWork(
  directory: string,
  workId: string,
  taskKey: string,
): TaskSessionState | null {
  const work = readBoulderWork(directory, workId)
  if (!work?.task_sessions) return null
  return work.task_sessions[taskKey] ?? null
}

export function upsertTaskSessionState(
  directory: string,
  input: {
    taskKey: string
    taskLabel: string
    taskTitle: string
    sessionId: string
    agent?: string
    category?: string
  },
): BoulderState | null {
  if (RESERVED_KEYS.has(input.taskKey)) return null

  const state = readBoulderState(directory)
  if (!state) return null

  // Find the most recently updated active work
  const activeWorks = getBoulderWorks(state)
    .filter((w) => w.status !== "completed" && w.status !== "abandoned")
    .sort((a, b) => {
      const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
      const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
      return bMs - aMs
    })

  if (activeWorks.length > 0) {
    return upsertTaskSessionStateForWork(directory, activeWorks[0].work_id, input)
  }

  // Fall back to any work
  const allWorks = getBoulderWorks(state)
  if (allWorks.length > 0) {
    return upsertTaskSessionStateForWork(directory, allWorks[0].work_id, input)
  }

  return null
}

export function upsertTaskSessionStateForWork(
  directory: string,
  workId: string,
  input: {
    taskKey: string
    taskLabel: string
    taskTitle: string
    sessionId: string
    agent?: string
    category?: string
  },
): BoulderState | null {
  if (RESERVED_KEYS.has(input.taskKey)) return null

  const state = readBoulderState(directory)
  if (!state) return null

  const targetWork = state.works[workId]
  if (!targetWork) return null

  const previousTaskSession = targetWork.task_sessions?.[input.taskKey]
  const nextTaskSession: TaskSessionState = {
    task_key: input.taskKey,
    task_label: input.taskLabel,
    task_title: input.taskTitle,
    session_id: input.sessionId,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(previousTaskSession?.started_at !== undefined ? { started_at: previousTaskSession.started_at } : {}),
    ...(previousTaskSession?.ended_at !== undefined ? { ended_at: previousTaskSession.ended_at } : {}),
    ...(previousTaskSession?.elapsed_ms !== undefined ? { elapsed_ms: previousTaskSession.elapsed_ms } : {}),
    ...(previousTaskSession?.status !== undefined ? { status: previousTaskSession.status } : {}),
    updated_at: nowIsoString(),
  }

  const nextWork: BoulderWorkState = {
    ...targetWork,
    task_sessions: {
      ...(targetWork.task_sessions ?? {}),
      [input.taskKey]: nextTaskSession,
    },
    updated_at: nowIsoString(),
  }

  // Write only the target work file
  if (!writeBoulderWork(directory, workId, nextWork)) return null

  // Update index (best-effort)
  const index = rebuildIndexFromWorkFiles(directory)
  writeBoulderIndex(directory, index)

  return {
    schema_version: 3,
    works: { ...state.works, [workId]: nextWork },
  }
}

// ─── task timer ────────────────────────────────────────────────────

export function startTaskTimer(
  directory: string,
  workId: string,
  input: {
    taskKey: string
    taskLabel: string
    taskTitle: string
    sessionId: string
    agent?: string
    category?: string
    startedAt?: string
  },
): BoulderState | null {
  const nextState = upsertTaskSessionStateForWork(directory, workId, input)
  if (!nextState) return null

  const work = nextState.works[workId]
  const taskSession = work?.task_sessions?.[input.taskKey]
  if (!work || !taskSession) return null

  const startedAt = taskSession.started_at ?? input.startedAt ?? nowIsoString()
  taskSession.started_at = startedAt
  taskSession.status = "running"
  taskSession.updated_at = nowIsoString()
  work.updated_at = nowIsoString()

  // Write only the target work file
  if (!writeBoulderWork(directory, workId, work)) return null

  return nextState
}

export function endTaskTimer(
  directory: string,
  workId: string,
  taskKey: string,
  endedAt?: string,
): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  const work = state.works[workId]
  if (!work?.task_sessions?.[taskKey]) return null

  const taskSession = work.task_sessions[taskKey]
  const endAt = endedAt ?? nowIsoString()
  taskSession.ended_at = endAt
  taskSession.elapsed_ms = getElapsedMs(taskSession.started_at, endAt)
  taskSession.status = "completed"
  taskSession.updated_at = nowIsoString()
  work.updated_at = nowIsoString()

  // Write only the target work file
  if (!writeBoulderWork(directory, workId, work)) return null

  return { schema_version: 3, works: { ...state.works, [workId]: work } }
}

// ─── completion ────────────────────────────────────────────────────

export function completeBoulder(directory: string, workId?: string, endedAt?: string): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  // If no workId specified, find the most recently updated active work
  let targetWorkId = workId
  if (!targetWorkId) {
    const activeWorks = getBoulderWorks(state)
      .filter((w) => w.status !== "completed" && w.status !== "abandoned")
      .sort((a, b) => {
        const aMs = parseIsoToMs(a.updated_at ?? a.started_at) ?? 0
        const bMs = parseIsoToMs(b.updated_at ?? b.started_at) ?? 0
        return bMs - aMs
      })
    if (activeWorks.length === 0) return null
    targetWorkId = activeWorks[0].work_id
  }

  const work = state.works[targetWorkId]
  if (!work) return null

  // Idempotent: if already completed with timing, return as-is
  if (work.status === "completed" && work.ended_at !== undefined && work.elapsed_ms !== undefined) {
    return state
  }

  const endAt = endedAt ?? nowIsoString()
  work.ended_at = endAt
  work.elapsed_ms = getElapsedMs(work.started_at, endAt)
  work.status = "completed"
  work.updated_at = nowIsoString()

  // Write only the target work file
  if (!writeBoulderWork(directory, targetWorkId, work)) return null

  // Update index (best-effort)
  const index = rebuildIndexFromWorkFiles(directory)
  writeBoulderIndex(directory, index)

  return { schema_version: 3, works: { ...state.works, [targetWorkId]: work } }
}

// ─── cleanup ───────────────────────────────────────────────────────

export function clearBoulderState(directory: string): boolean {
  try {
    // Remove v3 boulder directory
    const boulderDir = join(directory, BOULDER_DIR)
    if (existsSync(boulderDir)) {
      const { rmSync } = require("node:fs")
      rmSync(boulderDir, { recursive: true, force: true })
    }

    // Remove v2 boulder.json if it exists
    const v2Path = join(directory, BOULDER_V2_STATE_PATH)
    if (existsSync(v2Path)) {
      unlinkSync(v2Path)
    }

    return true
  } catch {
    return false
  }
}

// ─── plan file operations (unchanged from v2) ──────────────────────

/**
 * Find Prometheus plan files for this project.
 * Prometheus stores plans at: {project}/.sisyphus/plans/{name}.md
 */
export function findPrometheusPlans(directory: string): string[] {
  const plansDir = join(directory, PROMETHEUS_PLANS_DIR)

  if (!existsSync(plansDir)) {
    return []
  }

  try {
    const files = readdirSync(plansDir)
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(plansDir, f))
      .sort((a, b) => {
        const { statSync } = require("node:fs")
        const aStat = statSync(a)
        const bStat = statSync(b)
        return bStat.mtimeMs - aStat.mtimeMs
      })
  } catch {
    return []
  }
}

const TODO_HEADING_PATTERN = /^##\s+TODOs\b/i
const FINAL_VERIFICATION_HEADING_PATTERN = /^##\s+Final Verification Wave\b/i
const SECOND_LEVEL_HEADING_PATTERN = /^##\s+/
const UNCHECKED_CHECKBOX_PATTERN = /^(\s*)[-*]\s*\[\s*\]\s*(.+)$/
const CHECKED_CHECKBOX_PATTERN = /^(\s*)[-*]\s*\[[xX]\]\s*(.+)$/
const TODO_TASK_PATTERN = /^\d+\.\s+/
const FINAL_WAVE_TASK_PATTERN = /^F\d+\.\s+/i

type ProgressSection = "todo" | "final-wave" | "other"

/**
 * Parse a plan file and count checkbox progress.
 *
 * Only top-level (zero-indent) checkboxes under `## TODOs` and
 * `## Final Verification Wave` sections are counted. The checkbox
 * body must carry a valid task label (`N.` for TODOs, `FN.` for
 * Final Verification Wave). Nested acceptance-criteria checkboxes
 * and checkboxes in other sections are intentionally ignored so
 * that progress tracking stays aligned with `readCurrentTopLevelTask`.
 */
export function getPlanProgress(planPath: string): PlanProgress {
  if (!existsSync(planPath)) {
    return { total: 0, completed: 0, isComplete: false }
  }

  try {
    const content = readFileSync(planPath, "utf-8")
    const lines = content.split(/\r?\n/)

    const hasStructuredSections = lines.some(
      (line) => TODO_HEADING_PATTERN.test(line) || FINAL_VERIFICATION_HEADING_PATTERN.test(line),
    )

    if (hasStructuredSections) {
      return getStructuredPlanProgress(lines)
    }

    return getSimplePlanProgress(content)
  } catch {
    return { total: 0, completed: 0, isComplete: false }
  }
}

function getStructuredPlanProgress(lines: string[]): PlanProgress {
  let section: ProgressSection = "other"
  let total = 0
  let completed = 0

  for (const line of lines) {
    if (SECOND_LEVEL_HEADING_PATTERN.test(line)) {
      section = TODO_HEADING_PATTERN.test(line)
        ? "todo"
        : FINAL_VERIFICATION_HEADING_PATTERN.test(line)
          ? "final-wave"
          : "other"
      continue
    }

    if (section !== "todo" && section !== "final-wave") {
      continue
    }

    const checkedMatch = line.match(CHECKED_CHECKBOX_PATTERN)
    const uncheckedMatch = checkedMatch ? null : line.match(UNCHECKED_CHECKBOX_PATTERN)
    const match = checkedMatch ?? uncheckedMatch
    if (!match) continue

    if (match[1].length > 0) continue

    const taskBody = match[2].trim()
    const labelPattern = section === "todo" ? TODO_TASK_PATTERN : FINAL_WAVE_TASK_PATTERN
    if (!labelPattern.test(taskBody)) continue

    total++
    if (checkedMatch) completed++
  }

  return { total, completed, isComplete: total > 0 && completed === total }
}

function getSimplePlanProgress(content: string): PlanProgress {
  const uncheckedMatches = content.match(/^[-*]\s*\[\s*\]/gm) || []
  const checkedMatches = content.match(/^[-*]\s*\[[xX]\]/gm) || []

  const total = uncheckedMatches.length + checkedMatches.length
  const completed = checkedMatches.length

  return { total, completed, isComplete: total > 0 && completed === total }
}