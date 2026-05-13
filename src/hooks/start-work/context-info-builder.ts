import { statSync } from "node:fs"
import { basename } from "node:path"
import {
  appendSessionIdForWork,
  addBoulderWork,
  createBoulderState,
  findPrometheusPlans,
  getActiveWorks,
  getPlanProgress,
  getWorkById,
  getWorkByPlanName,
  getWorkResumeOptions,
  readBoulderState,
  readBoulderWork,
  resolveBoulderPlanPathForWork,
  selectActiveWork,
  writeBoulderState,
  writeBoulderWork,
} from "../../features/boulder-state"
import type { BoulderWorkState } from "../../features/boulder-state"
import { log } from "../../shared/logger"
import { createWorktreeActiveBlock } from "./worktree-block"
import type { PluginInput } from "@opencode-ai/plugin"
import { HOOK_NAME } from "./start-work-hook"

function getPlanName(planPath: string): string {
  return basename(planPath, ".md")
}

function normalizePlanLookupValue(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function findPlanByName(plans: string[], requestedName: string): string | null {
  const lowerName = requestedName.toLowerCase()
  const normalizedRequestedName = normalizePlanLookupValue(requestedName)
  const exactMatch = plans.find((p) => getPlanName(p).toLowerCase() === lowerName)
  if (exactMatch) return exactMatch
  const normalizedExactMatch = plans.find((planPath) =>
    normalizePlanLookupValue(getPlanName(planPath)) === normalizedRequestedName,
  )
  if (normalizedExactMatch) return normalizedExactMatch
  const partialMatch = plans.find((p) => getPlanName(p).toLowerCase().includes(lowerName))
  if (partialMatch) return partialMatch

  const normalizedPartialMatch = plans.find((planPath) =>
    normalizePlanLookupValue(getPlanName(planPath)).includes(normalizedRequestedName),
  )
  return normalizedPartialMatch || null
}

function buildAutoSelectedPlanContextInfoOnly(params: {
  planPath: string
  sessionId: string
  timestamp: string
  worktreeBlock: string
}): string {
  const { planPath, sessionId, timestamp, worktreeBlock } = params
  const progress = getPlanProgress(planPath)

  return `
## Auto-Selected Plan

**Plan**: ${getPlanName(planPath)}
**Path**: ${planPath}
**Progress**: ${progress.completed}/${progress.total} tasks
**Session ID**: ${sessionId}
**Started**: ${timestamp}
${worktreeBlock}

boulder.json has been created. Read the plan and begin execution.`
}

function buildAutoSelectedPlanContextWithStateInit(params: {
  planPath: string
  sessionId: string
  timestamp: string
  activeAgent: string
  worktreePath: string | undefined
  worktreeBlock: string
  directory: string
}): string {
  const { planPath, sessionId, timestamp, activeAgent, worktreePath, worktreeBlock, directory } = params
  const newState = createBoulderState(planPath, sessionId, activeAgent, worktreePath)
  writeBoulderState(directory, newState)

  return buildAutoSelectedPlanContextInfoOnly({
    planPath,
    sessionId,
    timestamp,
    worktreeBlock,
  })
}

function buildMissingPlanContext(explicitPlanName: string, allPlans: string[]): string {
  const incompletePlans = allPlans.filter((p) => !getPlanProgress(p).isComplete)
  if (incompletePlans.length > 0) {
    const planList = incompletePlans
      .map((p, i) => {
        const prog = getPlanProgress(p)
        return `${i + 1}. [${getPlanName(p)}] - Progress: ${prog.completed}/${prog.total}`
      })
      .join("\n")

    return `
## Plan Not Found

Could not find a plan matching "${explicitPlanName}".

Available incomplete plans:
${planList}

Ask the user which plan to work on.`
  }

  return `
## Plan Not Found

 Could not find a plan matching "${explicitPlanName}".
 No incomplete plans available. Create a new plan using the Prometheus agent.`
}

function formatElapsedHuman(elapsedMs: number | undefined): string {
  if (typeof elapsedMs !== "number" || elapsedMs <= 0) {
    return "running"
  }

  const totalSeconds = Math.floor(elapsedMs / 1000)
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }
  return `${seconds}s`
}

function buildMultipleActiveWorksContext(params: {
  resumeOptions: ReturnType<typeof getWorkResumeOptions>
  sessionId: string
  timestamp: string
}): string {
  const { resumeOptions, sessionId, timestamp } = params
  const optionList = resumeOptions
    .map((option, index) => `${index + 1}. ${option.plan_name} - ${option.progress.completed}/${option.progress.total} (${option.progress.total === 0 ? 0 : Math.floor((option.progress.completed / option.progress.total) * 100)}%) - elapsed: ${formatElapsedHuman(option.elapsed_ms)} - worktree: ${option.worktree_path ?? "current directory"} - sessions: ${option.session_count}`)
    .join("\n")

  return `
<system-reminder>
## Multiple Active Works Found

Current Time: ${timestamp}
Session ID: ${sessionId}

${optionList}

Use the Question tool to ask the user which plan to resume.
- If the user chooses one option, run /start-work {plan-name} for that plan.
- If the user chooses to start a new plan, proceed with cold-start auto-selection flow.
</system-reminder>`
}

function createNewWorkOrInitialize(params: {
  directory: string
  planPath: string
  sessionId: string
  activeAgent: string
  worktreePath: string | undefined
}): void {
  const { directory, planPath, sessionId, activeAgent, worktreePath } = params
  const created = addBoulderWork(directory, {
    planPath,
    sessionId,
    agent: activeAgent,
    worktreePath,
  })

  if (!created) {
    const initializedState = createBoulderState(planPath, sessionId, activeAgent, worktreePath)
    writeBoulderState(directory, initializedState)
  }
}

function buildExplicitPlanContext(params: {
  explicitPlanName: string
  sessionId: string
  timestamp: string
  activeAgent: string
  worktreePath: string | undefined
  worktreeBlock: string
  directory: string
}): string {
  const { explicitPlanName, sessionId, timestamp, activeAgent, worktreePath, worktreeBlock, directory } = params
  log(`[${HOOK_NAME}] Explicit plan name requested: ${explicitPlanName}`, { sessionID: sessionId })

  const matchedWork = getWorkByPlanName(directory, explicitPlanName, { worktreePath })
  if (matchedWork) {
    selectActiveWork(directory, matchedWork.work_id)
    return buildExistingSessionContext({
      work: matchedWork,
      sessionId,
      activeAgent,
      worktreePath,
      worktreeBlock,
      directory,
    })
  }

  const allPlans = findPrometheusPlans(directory)
  const matchedPlan = findPlanByName(allPlans, explicitPlanName)
  if (!matchedPlan) {
    return buildMissingPlanContext(explicitPlanName, allPlans)
  }

  const progress = getPlanProgress(matchedPlan)
  if (progress.isComplete) {
    return `
## Plan Already Complete

 The requested plan "${getPlanName(matchedPlan)}" has been completed.
 All ${progress.total} tasks are done. Create a new plan using the Prometheus agent.`
  }

  createNewWorkOrInitialize({
    directory,
    planPath: matchedPlan,
    sessionId,
    activeAgent,
    worktreePath,
  })

  return buildAutoSelectedPlanContextInfoOnly({
    planPath: matchedPlan,
    sessionId,
    timestamp,
    worktreeBlock,
  })
}

function buildExistingSessionContext(params: {
  work: BoulderWorkState
  sessionId: string
  activeAgent: string
  worktreePath: string | undefined
  worktreeBlock: string
  directory: string
}): string {
  const { work, sessionId, activeAgent, worktreePath, worktreeBlock, directory } = params
  const planPath = resolveBoulderPlanPathForWork(directory, work)
  const progress = getPlanProgress(planPath)
  if (progress.isComplete) {
    return `
## Previous Work Complete

The previous plan (${work.plan_name}) has been completed.
Looking for new plans...`
  }

  const effectiveWorktree = worktreePath ?? work.worktree_path
  const sessionAlreadyTracked = work.session_ids.includes(sessionId)
  const shouldRewriteState = work.agent !== activeAgent || worktreePath !== undefined

  // Always use appendSessionIdForWork for session tracking — it updates
  // session_origins and the index, not just the work file.
  if (!sessionAlreadyTracked) {
    appendSessionIdForWork(directory, work.work_id, sessionId)
  }

  if (shouldRewriteState) {
    // Re-read work after appendSessionIdForWork to get updated session_ids
    const refreshedWork = readBoulderWork(directory, work.work_id) ?? work
    const updatedWork: BoulderWorkState = {
      ...refreshedWork,
      agent: activeAgent,
      ...(worktreePath !== undefined ? { worktree_path: worktreePath } : {}),
      updated_at: new Date().toISOString(),
    }
    writeBoulderWork(directory, work.work_id, updatedWork)
  }

  const worktreeDisplay = effectiveWorktree
    ? (worktreeBlock || createWorktreeActiveBlock(effectiveWorktree))
    : worktreeBlock

  return `
## Active Work Session Found

**Status**: RESUMING existing work
**Plan**: ${work.plan_name}
**Path**: ${planPath}
**Progress**: ${progress.completed}/${progress.total} tasks completed
**Sessions**: ${work.session_ids.length + 1} (current session appended)
**Started**: ${work.started_at}
${worktreeDisplay}

The current session (${sessionId}) has been added to session_ids.
Read the plan file and continue from the first unchecked task.`
}

function shouldDiscoverPlans(
  directory: string,
  activeWork: BoulderWorkState | null,
  explicitPlanName: string | null,
): boolean {
  return (!activeWork && !explicitPlanName)
    || (
      activeWork !== null
      && !explicitPlanName
      && getPlanProgress(resolveBoulderPlanPathForWork(directory, activeWork)).isComplete
    )
}

function buildPlanDiscoveryContext(params: {
  contextInfo: string
  sessionId: string
  timestamp: string
  activeAgent: string
  worktreePath: string | undefined
  worktreeBlock: string
  directory: string
}): string {
  const { contextInfo, sessionId, timestamp, activeAgent, worktreePath, worktreeBlock, directory } = params
  const plans = findPrometheusPlans(directory)
  const incompletePlans = plans.filter((p) => !getPlanProgress(p).isComplete)

  if (plans.length === 0) {
    return contextInfo + `
## No Plans Found

 No Prometheus plan files found in the .sisyphus plans directory.
 Use the Prometheus agent to create a work plan first.`
  }

  if (incompletePlans.length === 0) {
    return contextInfo + `

## All Plans Complete

 All ${plans.length} plan(s) are complete. Create a new plan using the Prometheus agent.`
  }

  if (incompletePlans.length === 1) {
    return contextInfo + buildAutoSelectedPlanContextWithStateInit({
      planPath: incompletePlans[0],
      sessionId,
      timestamp,
      activeAgent,
      worktreePath,
      worktreeBlock,
      directory,
    })
  }

  const planList = incompletePlans
    .map((p, i) => {
      const progress = getPlanProgress(p)
      const modified = new Date(statSync(p).mtimeMs).toISOString()
      return `${i + 1}. [${getPlanName(p)}] - Modified: ${modified} - Progress: ${progress.completed}/${progress.total}`
    })
    .join("\n")

  return contextInfo + `

<system-reminder>
## Multiple Plans Found

Current Time: ${timestamp}
Session ID: ${sessionId}

${planList}

Ask the user which plan to work on. Present the options above and wait for their response.
${worktreeBlock}
</system-reminder>`
}

export function buildStartWorkContextInfo(params: {
  ctx: PluginInput
  explicitPlanName: string | null
  existingState: ReturnType<typeof readBoulderState>
  sessionId: string
  timestamp: string
  activeAgent: string
  worktreePath: string | undefined
  worktreeBlock: string
}): string {
  const { ctx, explicitPlanName, existingState, sessionId, timestamp, activeAgent, worktreePath, worktreeBlock } = params

  const resumeOptions = getWorkResumeOptions(ctx.directory)
    .filter((option) => option.status === "active" || option.status === "paused")

  if (!explicitPlanName && resumeOptions.length > 1) {
    return buildMultipleActiveWorksContext({
      resumeOptions,
      sessionId,
      timestamp,
    })
  }

  if (!explicitPlanName && resumeOptions.length === 1) {
    const onlyOption = resumeOptions[0]
    const work = getWorkById(ctx.directory, onlyOption.work_id)
    if (work) {
      selectActiveWork(ctx.directory, onlyOption.work_id)
      return buildExistingSessionContext({
        work,
        sessionId,
        activeAgent,
        worktreePath,
        worktreeBlock,
        directory: ctx.directory,
      })
    }
  }

  if (!explicitPlanName && resumeOptions.length === 0 && getActiveWorks(ctx.directory).length === 0) {
    return buildPlanDiscoveryContext({
      contextInfo: "",
      sessionId,
      timestamp,
      activeAgent,
      worktreePath,
      worktreeBlock,
      directory: ctx.directory,
    })
  }

  let contextInfo = ""
  if (explicitPlanName) {
    contextInfo = buildExplicitPlanContext({
      explicitPlanName,
      sessionId,
      timestamp,
      activeAgent,
      worktreePath,
      worktreeBlock,
      directory: ctx.directory,
    })
  } else if (existingState) {
    const activeWorks = getActiveWorks(ctx.directory)
    if (activeWorks.length > 0) {
      contextInfo = buildExistingSessionContext({
        work: activeWorks[0],
        sessionId,
        activeAgent,
        worktreePath,
        worktreeBlock,
        directory: ctx.directory,
      })
    }
  }

  // Find active work for plan discovery check
  const activeWorks = getActiveWorks(ctx.directory)
  const activeWork = activeWorks.length > 0 ? activeWorks[0] : null

  if (shouldDiscoverPlans(ctx.directory, activeWork, explicitPlanName)) {
    return buildPlanDiscoveryContext({
      contextInfo,
      sessionId,
      timestamp,
      activeAgent,
      worktreePath,
      worktreeBlock,
      directory: ctx.directory,
    })
  }

  return contextInfo
}