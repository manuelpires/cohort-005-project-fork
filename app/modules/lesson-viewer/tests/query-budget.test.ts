import { describe, it, expect, beforeEach } from "vitest";
import {
  countQueries,
  createTestDb,
  seedBaseData,
  type TestDb,
} from "~/test/setup";
import * as schema from "~/db/schema";
import {
  getCourseLessonProgressMap,
  getCourseOutline,
  markLessonComplete,
} from "~/modules/lesson-viewer/index.server";

const NOW = "2026-10-06T12:00:00.000Z";

// Query budgets: the count must not move when the data grows. A function
// that runs one query per row (N+1) passes every behaviour test and still
// times out on the first big course — these are the tests that catch it.

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleId: number;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  moduleId = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Module 1", position: 1 })
    .returning()
    .get().id;

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

describe("query budget", () => {
  function addLesson(position: number) {
    return db
      .insert(schema.lessons)
      .values({
        moduleId,
        title: `Lesson ${position}`,
        position,
      })
      .returning()
      .get();
  }

  it("reads the outline with a fixed query count, whatever it holds", () => {
    const twoLessons = countQueries(db, () =>
      getCourseOutline(db, base.course.id)
    ).queryCount;

    addLesson(3);
    addLesson(4);

    const fourLessons = countQueries(db, () =>
      getCourseOutline(db, base.course.id)
    ).queryCount;
    expect(fourLessons).toBe(twoLessons);
  });

  it("reads the progress map with a fixed query count, whatever it holds", () => {
    const empty = countQueries(db, () =>
      getCourseLessonProgressMap(db, base.user.id, base.course.id)
    ).queryCount;

    for (const lessonId of lessonIds) {
      markLessonComplete(db, base.user.id, lessonId, new Date(NOW));
    }

    const twoRows = countQueries(db, () =>
      getCourseLessonProgressMap(db, base.user.id, base.course.id)
    ).queryCount;
    expect(twoRows).toBe(empty);
  });
});
