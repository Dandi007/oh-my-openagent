import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { getLocalDevVersion } from "./local-dev-version"

function runGit(args: string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "git command failed")
  }
  return result.stdout.trim()
}

function createGitPackage(root: string): string {
  const packageRoot = join(root, "oh-my-openagent")
  mkdirSync(packageRoot, { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "oh-my-opencode", version: "4.0.0" }))
  runGit(["init"], packageRoot)
  runGit(["add", "package.json"], packageRoot)
  runGit(["-c", "user.name=OmO Test", "-c", "user.email=omo@example.com", "commit", "-m", "initial"], packageRoot)
  return packageRoot
}

describe("getLocalDevVersion", () => {
  let workdir: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "omo-local-dev-version-"))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it("reports observable version for a file protocol plugin from a git checkout", () => {
    // #given a local file protocol plugin configured from a git checkout
    const packageRoot = createGitPackage(workdir)
    const workspace = join(workdir, "workspace")
    const configDir = join(workspace, ".opencode")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "opencode.json"),
      JSON.stringify({ plugin: [pathToFileURL(packageRoot).href] }),
    )
    const shortCommit = runGit(["rev-parse", "--short", "HEAD"], packageRoot)

    // #when local dev version is detected
    const version = getLocalDevVersion(workspace)

    // #then it includes official version, personal tag, and current commit
    expect(version).toBe(`4.0.0-ql-${shortCommit}`)
  })
})
