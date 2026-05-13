/** Shared helpers for decoding OpenCode session message/part rows.
 *  Used by both sql-search (query-time excerpt mapping) and vector-build (build-time chunk mapping).
 *  Do NOT force these two pipelines into one abstraction — only truly identical row decoding lives here. */

/**
 * Parse a JSON string from the OpenCode DB into a record.
 *
 * By default, returns {} on parse failure or non-object values (lenient — used by SQL search).
 * Pass { strict: true } to throw on malformed JSON (used by vector build).
 */
export function parseSessionData(
  data: string,
  opts?: { strict?: boolean },
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(data || "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    if (opts?.strict) {
      throw new Error(`failed to parse OpenCode session JSON: ${String(error)}`)
    }
  }
  return {}
}

/**
 * Extract the role from message data JSON.
 * Returns "unknown" when role is missing or empty.
 */
export function extractRole(data: string): string {
  const parsed = parseSessionData(data)
  return typeof parsed.role === "string" && parsed.role.length > 0 ? parsed.role : "unknown"
}

/** A single text fragment extracted from a known field. */
export interface TextFragment {
  text: string
  field: string
}

/**
 * Extract searchable text fragments from parsed message/part data.
 *
 * Covers the fields common to both SQL search and vector build:
 * text, thinking, state.title, state.output, prompt, description.
 *
 * Callers that need reasoning should add it separately.
 * Callers that need raw JSON (for fallback matching) should compute it separately.
 */
export function extractCoreTextFragments(parsed: Record<string, unknown>): TextFragment[] {
  const fragments: TextFragment[] = []

  const push = (value: unknown, field: string) => {
    if (typeof value === "string" && value.length > 0) {
      fragments.push({ text: value, field })
    }
  }

  push(parsed.text, "text")
  push(parsed.thinking, "thinking")

  const state = parsed.state
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const s = state as Record<string, unknown>
    push(s.title, "state.title")
    push(s.output, "state.output")
  }

  push(parsed.prompt, "prompt")
  push(parsed.description, "description")

  return fragments
}