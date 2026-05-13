import { afterAll, describe, expect, it } from "bun:test"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as lancedb from "@lancedb/lancedb"

const TEST_DB_PATH = join(tmpdir(), "lancedb-smoke-test-" + Date.now())

describe("LanceDB smoke gate", () => {
  // #given the @lancedb/lancedb package is installed
  // #when we import it
  // #then the module is defined and has expected exports
  it("imports @lancedb/lancedb successfully", () => {
    expect(lancedb).toBeDefined()
    expect(typeof lancedb.connect).toBe("function")
  })

  describe("connect, create table, insert, query", () => {
    // #given a temp LanceDB directory
    // #when we connect, create a table, insert two known vectors, and query nearest neighbor
    // #then the row closer to the query vector ranks first
    it("creates table, inserts vectors, queries nearest neighbor", async () => {
      // #given: connect to temp LanceDB
      const db = await lancedb.connect(TEST_DB_PATH)

      // #given: two deterministic vectors and a query vector closer to row 1
      const vectorA = [1.0, 0.0, 0.0]
      const vectorB = [0.0, 1.0, 0.0]
      const queryVector = [0.9, 0.1, 0.0]

      const data = [
        { chunk_id: "chunk-alpha", vector: vectorA, text: "alpha text" },
        { chunk_id: "chunk-beta", vector: vectorB, text: "beta text" },
      ]

      // #when: create table and insert data
      const table = await db.createTable("smoke_test", data)

      // #when: query nearest neighbor
      const results = await table
        .search(queryVector)
        .limit(2)
        .toArray()

      // #then: two results returned
      expect(results).toHaveLength(2)

      // #then: chunk-alpha ranks first (closer to query vector)
      expect(results[0].chunk_id).toBe("chunk-alpha")

      // #then: chunk-beta ranks second
      expect(results[1].chunk_id).toBe("chunk-beta")

      // #then: scores are descending (first score >= second score)
      expect(results[0]._distance).toBeLessThanOrEqual(results[1]._distance)
    })
  })

  // #given the smoke test created a temp LanceDB directory
  // #when the suite finishes
  // #then the temp directory is removed
  afterAll(() => {
    rmSync(TEST_DB_PATH, { recursive: true, force: true })
  })
})