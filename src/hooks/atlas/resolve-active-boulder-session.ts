import type { PluginInput } from "@opencode-ai/plugin"
import {
  getPlanProgress,
  getWorkForSessionStrict,
  readBoulderState,
  resolveBoulderPlanPathForWork,
} from "../../features/boulder-state"
import type { BoulderWorkState, PlanProgress } from "../../features/boulder-state"

export async function resolveActiveBoulderSession(input: {
  client: PluginInput["client"]
  directory: string
  sessionID: string
}): Promise<{
  work: BoulderWorkState
  progress: PlanProgress
  appendedSession: boolean
} | null> {
  const boulderState = readBoulderState(input.directory)
  if (!boulderState) {
    return null
  }

  const { work, error } = getWorkForSessionStrict(input.directory, input.sessionID)
  if (error) {
    console.error(`[resolveActiveBoulderSession] ${error}`)
    return null
  }
  if (!work) {
    return null
  }

  const progress = getPlanProgress(
    resolveBoulderPlanPathForWork(input.directory, work),
  )
  if (progress.isComplete) {
    return { work, progress, appendedSession: false }
  }

  return { work, progress, appendedSession: false }
}