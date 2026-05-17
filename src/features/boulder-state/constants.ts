/**
 * Boulder State Constants
 *
 * v3 paths (current):
 *   .sisyphus/boulder/{work_id}.json  — individual work state files
 *   .sisyphus/boulder/index.json       — session→work lookup
 *   .sisyphus/boulder/.migrated        — migration completion marker
 *
 * v2 paths (legacy, preserved for migration):
 *   .sisyphus/boulder.json             — single-file boulder state
 */

// ─── v3 paths ──────────────────────────────────────────────────────

/** Directory for individual work state files */
export const BOULDER_DIR = ".sisyphus/boulder"

/** Session→work index file (inside BOULDER_DIR) */
export const BOULDER_INDEX_FILE = "index.json"

/** Full path to the index file */
export const BOULDER_INDEX_PATH = `${BOULDER_DIR}/${BOULDER_INDEX_FILE}`

/** Marker file created after successful v2→v3 migration */
export const BOULDER_MIGRATED_MARKER = ".migrated"

/** Full path to the migration marker */
export const BOULDER_MIGRATED_PATH = `${BOULDER_DIR}/${BOULDER_MIGRATED_MARKER}`

/** Suffix appended to v2 boulder.json when backing up during migration */
export const BOULDER_V2_BACKUP_SUFFIX = ".v2.bak"

// ─── v2 paths (legacy) ─────────────────────────────────────────────

/** @deprecated Use BOULDER_DIR + work_id for v3 paths */
export const BOULDER_V2_DIR = ".sisyphus"

/** @deprecated Use BOULDER_DIR + work_id for v3 paths */
export const BOULDER_V2_FILE = "boulder.json"

/** @deprecated Use BOULDER_DIR + work_id for v3 paths */
export const BOULDER_V2_STATE_PATH = `${BOULDER_V2_DIR}/${BOULDER_V2_FILE}`

/**
 * @deprecated Use BOULDER_V2_FILE instead.
 *   Kept for backward compatibility with storage.ts.
 */
export const BOULDER_FILE = BOULDER_V2_FILE

/**
 * @deprecated Use BOULDER_V2_STATE_PATH instead.
 *   Kept for backward compatibility with storage.ts.
 */
export const BOULDER_STATE_PATH = BOULDER_V2_STATE_PATH

// ─── shared paths ──────────────────────────────────────────────────

export const NOTEPAD_DIR = "notepads"
export const NOTEPAD_BASE_PATH = `${BOULDER_V2_DIR}/${NOTEPAD_DIR}`

/** Prometheus plan directory pattern */
export const PROMETHEUS_PLANS_DIR = ".sisyphus/plans"
