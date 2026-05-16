/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PLUGIN_NAME } from "../../../shared"
import type { PluginInfo } from "./system-plugin"
import type { OpenCodeBinaryInfo } from "./system-binary"
import { checkSystem } from "./system"

const mockFindOpenCodeBinary = mock<() => Promise<OpenCodeBinaryInfo | null>>(async () => ({
  binary: "opencode",
  path: "/usr/local/bin/opencode",
}))
const mockGetOpenCodeVersion = mock(async () => "1.0.200")
const mockCompareVersions = mock((_leftVersion?: string, _rightVersion?: string) => true)
const mockGetPluginInfo = mock((): PluginInfo => ({
  registered: true,
  entry: "oh-my-opencode",
  isPinned: false,
  pinnedVersion: null,
  configPath: null,
  isLocalDev: false,
  localDevPath: null,
}))
const mockGetLoadedPluginVersion = mock(() => ({
  cacheDir: "/Users/test/Library/Caches/opencode with spaces",
  cachePackagePath: "/tmp/package.json",
  installedPackagePath: "/tmp/node_modules/oh-my-opencode/package.json",
  expectedVersion: "3.0.0",
  loadedVersion: "3.1.0",
}))
const mockGetLatestPluginVersion = mock(async (_currentVersion: string | null) => null as string | null)
const mockGetSuggestedInstallTag = mock(() => "latest")


function createSystemDeps() {
  return {
    findOpenCodeBinary: mockFindOpenCodeBinary,
    getOpenCodeVersion: mockGetOpenCodeVersion,
    compareVersions: mockCompareVersions,
    getPluginInfo: mockGetPluginInfo,
    getLoadedPluginVersion: mockGetLoadedPluginVersion,
    getLatestPluginVersion: mockGetLatestPluginVersion,
    getSuggestedInstallTag: mockGetSuggestedInstallTag,
  }
}

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

describe("system check", () => {
  let temporaryDirectories: string[] = []

  beforeEach(() => {
    temporaryDirectories = []
    mockFindOpenCodeBinary.mockReset()
    mockGetOpenCodeVersion.mockReset()
    mockCompareVersions.mockReset()
    mockGetPluginInfo.mockReset()
    mockGetLoadedPluginVersion.mockReset()
    mockGetLatestPluginVersion.mockReset()
    mockGetSuggestedInstallTag.mockReset()

    mockFindOpenCodeBinary.mockResolvedValue({
      binary: "opencode",
      path: "/usr/local/bin/opencode",
    })
    mockGetOpenCodeVersion.mockResolvedValue("1.0.200")
    mockCompareVersions.mockReturnValue(true)
    mockGetPluginInfo.mockReturnValue({
      registered: true,
      entry: "oh-my-opencode",
      isPinned: false,
      pinnedVersion: null,
      configPath: null,
      isLocalDev: false,
      localDevPath: null,
    })
    mockGetLoadedPluginVersion.mockReturnValue({
      cacheDir: "/Users/test/Library/Caches/opencode with spaces",
      cachePackagePath: "/tmp/package.json",
      installedPackagePath: "/tmp/node_modules/oh-my-opencode/package.json",
      expectedVersion: "3.0.0",
      loadedVersion: "3.1.0",
    })
    mockGetLatestPluginVersion.mockResolvedValue(null)
    mockGetSuggestedInstallTag.mockReturnValue("latest")
  })

  afterEach(() => {
    for (const temporaryDirectory of temporaryDirectories) {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  describe("#given cache directory contains spaces", () => {
    it("uses a quoted cache directory in mismatch fix command", async () => {
      //#given
      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      const mismatchIssue = result.issues.find((issue) => issue.title === "Loaded plugin version mismatch")
      expect(mismatchIssue?.fix).toBe('Reinstall: cd "/Users/test/Library/Caches/opencode with spaces" && bun install')
    })

    it("uses the loaded version channel for update fix command", async () => {
      //#given
      mockGetLoadedPluginVersion.mockReturnValue({
        cacheDir: "/Users/test/Library/Caches/opencode with spaces",
        cachePackagePath: "/tmp/package.json",
        installedPackagePath: "/tmp/node_modules/oh-my-opencode/package.json",
        expectedVersion: "3.0.0-canary.1",
        loadedVersion: "3.0.0-canary.1",
      })
      mockGetLatestPluginVersion.mockResolvedValue("3.0.0-canary.2")
      mockGetSuggestedInstallTag.mockReturnValue("canary")
      mockCompareVersions
        .mockImplementationOnce(() => true)
        .mockImplementationOnce(() => false)

      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      const outdatedIssue = result.issues.find((issue) => issue.title === "Loaded plugin is outdated")
      expect(outdatedIssue?.fix).toBe(
        'Update: cd "/Users/test/Library/Caches/opencode with spaces" && bun add oh-my-opencode@canary'
      )
    })
  })

  describe("#given OpenCode plugin entry uses legacy package name", () => {
    it("adds a warning for a bare legacy entry", async () => {
      //#given
      mockGetPluginInfo.mockReturnValue({
        registered: true,
        entry: "oh-my-opencode",
        isPinned: false,
        pinnedVersion: null,
        configPath: null,
        isLocalDev: false,
        localDevPath: null,
      })

      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      const legacyEntryIssue = result.issues.find((issue) => issue.title === "Using legacy package name")
      expect(legacyEntryIssue?.severity).toBe("warning")
      expect(legacyEntryIssue?.fix).toBe(
        'Update your opencode.json plugin entry: "oh-my-opencode" → "oh-my-openagent"'
      )
    })

    it("adds a warning for a version-pinned legacy entry", async () => {
      //#given
      mockGetPluginInfo.mockReturnValue({
        registered: true,
        entry: "oh-my-opencode@3.0.0",
        isPinned: true,
        pinnedVersion: "3.0.0",
        configPath: null,
        isLocalDev: false,
        localDevPath: null,
      })

      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      const legacyEntryIssue = result.issues.find((issue) => issue.title === "Using legacy package name")
      expect(legacyEntryIssue?.severity).toBe("warning")
      expect(legacyEntryIssue?.fix).toBe(
        'Update your opencode.json plugin entry: "oh-my-opencode@3.0.0" → "oh-my-openagent@3.0.0"'
      )
    })

    it("does not warn for a canonical plugin entry", async () => {
      //#given
      mockGetPluginInfo.mockReturnValue({
        registered: true,
        entry: PLUGIN_NAME,
        isPinned: false,
        pinnedVersion: null,
        configPath: null,
        isLocalDev: false,
        localDevPath: null,
      })

      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      expect(result.issues.some((issue) => issue.title === "Using legacy package name")).toBe(false)
    })

    it("does not warn for a local-dev legacy entry", async () => {
      //#given
      mockGetPluginInfo.mockReturnValue({
        registered: true,
        entry: "oh-my-opencode",
        isPinned: false,
        pinnedVersion: null,
        configPath: null,
        isLocalDev: true,
        localDevPath: null,
      })

      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      expect(result.issues.some((issue) => issue.title === "Using legacy package name")).toBe(false)
    })
  })

  describe("#given local file protocol plugin points at a git checkout", () => {
    it("uses the observable local version in system details", async () => {
      //#given
      const workdir = mkdtempSync(join(tmpdir(), "omo-doctor-system-"))
      temporaryDirectories.push(workdir)
      const packageRoot = createGitPackage(workdir)
      const shortCommit = runGit(["rev-parse", "--short", "HEAD"], packageRoot)
      mockGetPluginInfo.mockReturnValue({
        registered: true,
        entry: `file://${packageRoot}`,
        isPinned: false,
        pinnedVersion: null,
        configPath: null,
        isLocalDev: true,
        localDevPath: packageRoot,
      })

      //#when
      const result = await checkSystem(createSystemDeps())

      //#then
      expect(result.details).toContain(`Plugin expected: 4.0.0-ql-${shortCommit}`)
    })
  })
})
