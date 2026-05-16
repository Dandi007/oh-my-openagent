import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { ACCEPTED_PACKAGE_NAMES } from "./plugin-identity"

const PERSONAL_VERSION_TAG = "ql"
const ACCEPTED_PACKAGE_NAME_SET = new Set<string>(ACCEPTED_PACKAGE_NAMES)

interface PackageJsonShape {
  name?: string
  version?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPackageJson(packageJsonPath: string): PackageJsonShape | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"))
    if (!isRecord(parsed)) return null

    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    }
  } catch {
    return null
  }
}

function runGit(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  })

  if (result.status !== 0) return null
  const stdout = result.stdout.trim()
  return stdout.length > 0 ? stdout : null
}

function getGitRoot(packageJsonPath: string): string | null {
  const packageDir = path.dirname(packageJsonPath)
  const gitRoot = runGit(["rev-parse", "--show-toplevel"], packageDir)
  return gitRoot ? path.resolve(gitRoot) : null
}

export function formatObservableVersion(officialVersion: string, shortCommit: string | null | undefined): string {
  const commit = shortCommit?.trim()
  if (!commit) return officialVersion
  return `${officialVersion}-${PERSONAL_VERSION_TAG}-${commit}`
}

export function findAcceptedPackageJsonUp(startPath: string): string | null {
  try {
    const stat = fs.statSync(startPath)
    let dir = stat.isDirectory() ? startPath : path.dirname(startPath)

    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, "package.json")
      if (fs.existsSync(pkgPath)) {
        const pkg = readPackageJson(pkgPath)
        if (pkg?.name && ACCEPTED_PACKAGE_NAME_SET.has(pkg.name)) return pkgPath
      }

      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    return null
  }

  return null
}

export function getGitShortCommitForPackageJsonPath(packageJsonPath: string): string | null {
  const normalizedPackageJsonPath = path.resolve(packageJsonPath)
  const gitRoot = getGitRoot(normalizedPackageJsonPath)
  if (!gitRoot) return null

  const rootPackageJsonPath = path.join(gitRoot, "package.json")
  if (path.resolve(rootPackageJsonPath) !== normalizedPackageJsonPath) return null

  return runGit(["rev-parse", "--short", "HEAD"], gitRoot)
}

export function getObservableVersionFromPackageJsonPath(packageJsonPath: string): string | null {
  const pkg = readPackageJson(packageJsonPath)
  if (!pkg?.version) return null

  const shortCommit = getGitShortCommitForPackageJsonPath(packageJsonPath)
  return formatObservableVersion(pkg.version, shortCommit)
}

export function getObservableVersionFromPackagePath(startPath: string): string | null {
  const packageJsonPath = findAcceptedPackageJsonUp(startPath)
  if (!packageJsonPath) return null
  return getObservableVersionFromPackageJsonPath(packageJsonPath)
}
