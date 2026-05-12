import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface DefaultVectorCachePaths {
  cacheDir: string
  indexPath: string
  manifestPath: string
}

export interface DefaultVectorCachePathOptions {
  createDirectories?: boolean
}

const CACHE_VENDOR_DIR = "oh-my-opencode"
const CACHE_FEATURE_DIR = "vector"
const DEFAULT_INDEX_DIR = "opencode-sessions"
const DEFAULT_MANIFEST_FILE = "vector-manifest.json"

function getCacheHome(env?: Record<string, string | undefined>): string {
  const source = env ?? (typeof process !== "undefined" ? process.env as Record<string, string | undefined> : {})
  const xdgCacheHome = source.XDG_CACHE_HOME?.trim()
  return xdgCacheHome || join(homedir(), ".cache")
}

export function getDefaultVectorCachePaths(
  env?: Record<string, string | undefined>,
  options: DefaultVectorCachePathOptions = {},
): DefaultVectorCachePaths {
  const cacheDir = join(getCacheHome(env), CACHE_VENDOR_DIR, CACHE_FEATURE_DIR)
  if (options.createDirectories === true && !existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true })
  }

  return {
    cacheDir,
    indexPath: join(cacheDir, DEFAULT_INDEX_DIR),
    manifestPath: join(cacheDir, DEFAULT_MANIFEST_FILE),
  }
}
