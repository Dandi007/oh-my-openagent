import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { formatObservableVersion, getObservableVersionFromPackageJsonPath } from "./observable-version"

describe("observable version", () => {
  let workdir: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "omo-observable-version-"))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it("formats official version with ql personal tag and git short commit", () => {
    // #given official package version and git short commit
    // #when observable version is formatted
    const version = formatObservableVersion("4.0.0", "abcdef1")

    // #then the personal tag is included between them
    expect(version).toBe("4.0.0-ql-abcdef1")
  })

  it("falls back to official package version when git metadata is unavailable", () => {
    // #given package json outside a git checkout
    const packageJsonPath = join(workdir, "package.json")
    writeFileSync(packageJsonPath, JSON.stringify({ name: "oh-my-opencode", version: "4.0.0" }))

    // #when observable version is read
    const version = getObservableVersionFromPackageJsonPath(packageJsonPath)

    // #then official version is preserved
    expect(version).toBe("4.0.0")
  })
})
