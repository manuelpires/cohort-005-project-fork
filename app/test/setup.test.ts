import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  countQueries,
  createTestDb,
  seedBaseData,
  type TestDb,
} from "~/test/setup";
import * as schema from "~/db/schema";

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

describe("countQueries", () => {
  it("counts the statements a call prepares", () => {
    const { queryCount } = countQueries(db, () => {
      db.select().from(schema.courses).all();
    });
    expect(queryCount).toBe(1);
  });

  it("counts one statement per iteration of a loop — the N+1 shape", () => {
    const { queryCount } = countQueries(db, () => {
      for (const id of [1, 2, 3]) {
        db.select().from(schema.lessons).where(eq(schema.lessons.id, id)).get();
      }
    });
    expect(queryCount).toBe(3);
  });

  it("excludes statements prepared before the counted call", () => {
    db.select().from(schema.courses).all();

    const { queryCount } = countQueries(db, () => {});
    expect(queryCount).toBe(0);
  });

  it("hands back the call's return value", () => {
    const { result } = countQueries(db, () => seedBaseData(db));
    expect(result.course.slug).toBe("test-course");
  });

  it("rejects a db it did not create", () => {
    const stranger = { $client: {} } as unknown as TestDb;
    expect(() => countQueries(stranger, () => {})).toThrow("createTestDb");
  });
});
