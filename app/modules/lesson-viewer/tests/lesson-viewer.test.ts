import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { LessonProgressStatus, UserRole } from "~/db/schema";
import { markdown } from "~/lib/text";
import {
  getCourseOutline,
  getLesson,
  getLessonNeighbours,
  getModule,
  getUser,
} from "~/modules/lesson-viewer/index.server";
import {
  calculateWatchProgress,
  getCourseLessonProgressMap,
  getLastWatchPosition,
  getLessonProgress,
  markLessonComplete,
  markLessonInProgress,
} from "~/modules/lesson-viewer/index.server";
import {
  getCommentById,
  getRenderedThread,
} from "~/modules/lesson-viewer/index.server";

const NOW = "2026-10-06T12:00:00.000Z";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleIds: number[];
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  moduleIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.modules)
        .values({
          courseId: base.course.id,
          title: `Module ${position}`,
          position,
        })
        .returning()
        .get().id
  );

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({
          moduleId: moduleIds[0],
          title: `Lesson ${position}`,
          position,
        })
        .returning()
        .get().id
  );
});

describe("the course outline", () => {
  it("returns the course with its modules and each module's lessons in position order", () => {
    const outline = getCourseOutline(db, base.course.id);
    if (!outline) throw new Error("the seeded course exists");

    expect(outline).toMatchObject({
      id: base.course.id,
      title: "Test Course",
      slug: "test-course",
      instructorName: "Test Instructor",
      modules: [
        {
          title: "Module 1",
          lessons: [{ title: "Lesson 1" }, { title: "Lesson 2" }],
        },
        { title: "Module 2", lessons: [] },
      ],
    });
  });

  it("returns null for a course that does not exist", () => {
    expect(getCourseOutline(db, 999)).toBeNull();
  });

  it("returns a course with no modules as having none", () => {
    const bare = db
      .insert(schema.courses)
      .values({
        title: "Bare Course",
        slug: "bare-course",
        description: "No modules yet",
        salesCopy: markdown("## Bare"),
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();

    expect(getCourseOutline(db, bare.id)).toMatchObject({
      title: "Bare Course",
      modules: [],
    });
  });

  it("looks up a lesson, a module and a person by id", () => {
    expect(getLesson(db, lessonIds[0])).toMatchObject({
      title: "Lesson 1",
      moduleId: moduleIds[0],
    });
    expect(getModule(db, moduleIds[0])).toMatchObject({
      title: "Module 1",
      courseId: base.course.id,
    });
    expect(getUser(db, base.user.id)).toMatchObject({
      name: "Test User",
      role: UserRole.Student,
    });
    expect(getLesson(db, 999)).toBeUndefined();
    expect(getModule(db, 999)).toBeUndefined();
    expect(getUser(db, 999)).toBeUndefined();
  });

  it("names the lessons either side of this one across the whole course", () => {
    const later = db
      .insert(schema.lessons)
      .values({ moduleId: moduleIds[1], title: "Lesson 3", position: 1 })
      .returning()
      .get();

    expect(getLessonNeighbours(db, base.course.id, lessonIds[0])).toEqual({
      prevLesson: null,
      nextLesson: { id: lessonIds[1], title: "Lesson 2" },
    });
    expect(getLessonNeighbours(db, base.course.id, lessonIds[1])).toEqual({
      prevLesson: { id: lessonIds[0], title: "Lesson 1" },
      nextLesson: { id: later.id, title: "Lesson 3" },
    });
    expect(getLessonNeighbours(db, base.course.id, later.id)).toEqual({
      prevLesson: { id: lessonIds[1], title: "Lesson 2" },
      nextLesson: null,
    });
    expect(getLessonNeighbours(db, base.course.id, 999)).toEqual({
      prevLesson: null,
      nextLesson: null,
    });
    // An unknown course has neither neighbour either.
    expect(getLessonNeighbours(db, 999, lessonIds[0])).toEqual({
      prevLesson: null,
      nextLesson: null,
    });
  });
});

describe("lesson progress", () => {
  it("marks a lesson in progress on the first visit and never demotes a completed one", () => {
    const first = markLessonInProgress(db, base.user.id, lessonIds[0]);
    expect(first.status).toBe(LessonProgressStatus.InProgress);

    const again = markLessonInProgress(db, base.user.id, lessonIds[0]);
    expect(again.id).toBe(first.id);

    markLessonComplete(db, base.user.id, lessonIds[0]);
    const revisit = markLessonInProgress(db, base.user.id, lessonIds[0]);
    expect(revisit.status).toBe(LessonProgressStatus.Completed);
  });

  it("marks a lesson complete, creating the row when it does not exist yet", () => {
    expect(getLessonProgress(db, base.user.id, lessonIds[0])).toBeUndefined();

    const completed = markLessonComplete(db, base.user.id, lessonIds[0]);
    expect(completed).toMatchObject({
      status: LessonProgressStatus.Completed,
      completedAt: expect.any(String),
    });
    expect(getLessonProgress(db, base.user.id, lessonIds[0])?.id).toBe(
      completed.id
    );
  });

  it("maps each course lesson to its status, and only course lessons", () => {
    const otherCourse = db
      .insert(schema.courses)
      .values({
        title: "Other Course",
        slug: "other-course",
        description: "Another course",
        salesCopy: markdown("## Other"),
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    const otherModule = db
      .insert(schema.modules)
      .values({
        courseId: otherCourse.id,
        title: "Elsewhere",
        position: 1,
      })
      .returning()
      .get();
    const otherLesson = db
      .insert(schema.lessons)
      .values({
        moduleId: otherModule.id,
        title: "Elsewhere lesson",
        position: 1,
      })
      .returning()
      .get();

    markLessonComplete(db, base.user.id, lessonIds[0]);
    markLessonInProgress(db, base.user.id, lessonIds[1]);
    markLessonComplete(db, base.user.id, otherLesson.id);

    expect(
      getCourseLessonProgressMap(db, base.user.id, base.course.id)
    ).toEqual({
      [lessonIds[0]]: LessonProgressStatus.Completed,
      [lessonIds[1]]: LessonProgressStatus.InProgress,
    });
    expect(
      getCourseLessonProgressMap(db, base.user.id, otherCourse.id)
    ).toEqual({ [otherLesson.id]: LessonProgressStatus.Completed });
  });

  it("leaves lessons without progress out of the map", () => {
    markLessonComplete(db, base.user.id, lessonIds[0]);

    expect(
      getCourseLessonProgressMap(db, base.user.id, base.course.id)
    ).toEqual({ [lessonIds[0]]: LessonProgressStatus.Completed });
  });

  it("maps nothing for a course that has no lessons of its own", () => {
    // Progress on another course's lesson must not leak into this course.
    const lessonless = db
      .insert(schema.courses)
      .values({
        title: "Lessonless Course",
        slug: "lessonless-course",
        description: "A module with no lessons",
        salesCopy: markdown("## Lessonless"),
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    markLessonComplete(db, base.user.id, lessonIds[0]);

    // A course with no modules at all
    expect(getCourseLessonProgressMap(db, base.user.id, lessonless.id)).toEqual(
      {}
    );

    // A course with a module but no lessons under it
    db.insert(schema.modules)
      .values({ courseId: lessonless.id, title: "Empty", position: 1 })
      .run();
    expect(getCourseLessonProgressMap(db, base.user.id, lessonless.id)).toEqual(
      {}
    );
  });
});

describe("video watch state", () => {
  it("starts at 0 seconds and follows the latest event", () => {
    expect(getLastWatchPosition(db, base.user.id, lessonIds[0])).toBe(0);

    db.insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        eventType: "seek",
        positionSeconds: 42,
        createdAt: NOW,
      })
      .run();
    db.insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        eventType: "seek",
        positionSeconds: 90,
        createdAt: "2026-10-06T12:01:00.000Z",
      })
      .run();

    expect(getLastWatchPosition(db, base.user.id, lessonIds[0])).toBe(90);
  });

  it("shows progress as a percentage of the video, clamped to 100", () => {
    // No events yet: the furthest point is the start of the video.
    expect(
      calculateWatchProgress(db, {
        userId: base.user.id,
        lessonId: lessonIds[0],
        videoDurationSeconds: 90,
      })
    ).toBe(0);

    expect(
      calculateWatchProgress(db, {
        userId: base.user.id,
        lessonId: lessonIds[0],
        videoDurationSeconds: 0,
      })
    ).toBe(0);

    db.insert(schema.videoWatchEvents)
      .values({
        userId: base.user.id,
        lessonId: lessonIds[0],
        eventType: "seek",
        positionSeconds: 45,
        createdAt: NOW,
      })
      .run();

    expect(
      calculateWatchProgress(db, {
        userId: base.user.id,
        lessonId: lessonIds[0],
        videoDurationSeconds: 90,
      })
    ).toBe(50);
    expect(
      calculateWatchProgress(db, {
        userId: base.user.id,
        lessonId: lessonIds[0],
        videoDurationSeconds: 30,
      })
    ).toBe(100);
  });
});

describe("the discussion thread", () => {
  function insertComment(values: {
    lessonId: number;
    userId: number;
    body: string;
    parentId?: number;
    deletedAt?: string;
  }) {
    return db
      .insert(schema.comments)
      .values({
        lessonId: values.lessonId,
        userId: values.userId,
        body: markdown(values.body),
        parentId: values.parentId ?? null,
        deletedAt: values.deletedAt ?? null,
        createdAt: NOW,
      })
      .returning()
      .get();
  }

  it("returns questions with their replies, bodies rendered to HTML", async () => {
    const question = insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "How does this work?",
    });
    const reply = insertComment({
      lessonId: lessonIds[0],
      userId: base.instructor.id,
      body: "Like **this**",
      parentId: question.id,
    });

    const thread = await getRenderedThread(db, lessonIds[0]);

    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({
      id: question.id,
      deleted: false,
      author: {
        id: base.user.id,
        isInstructor: false,
        isPlatformAdmin: false,
      },
      replies: [
        {
          id: reply.id,
          author: { id: base.instructor.id, isInstructor: true },
        },
      ],
    });
    expect(thread[0].bodyHtml).toContain("How does this work?");
    expect(thread[0].replies[0].bodyHtml).toContain("<strong>this</strong>");
  });

  it("badges a Platform Admin's comment as one", async () => {
    const admin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    insertComment({
      lessonId: lessonIds[0],
      userId: admin.id,
      body: "Staff post",
    });

    const thread = await getRenderedThread(db, lessonIds[0]);

    expect(thread[0].author).toMatchObject({
      id: admin.id,
      isPlatformAdmin: true,
      isInstructor: false,
    });
  });

  it("hides a deleted question with no replies, but keeps one that still has replies", async () => {
    const deletedEmpty = insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "Deleted with nothing under it",
      deletedAt: NOW,
    });
    const deletedWithReplies = insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "Deleted but answered",
      deletedAt: NOW,
    });
    insertComment({
      lessonId: lessonIds[0],
      userId: base.instructor.id,
      body: "A reply worth keeping",
      parentId: deletedWithReplies.id,
    });

    const thread = await getRenderedThread(db, lessonIds[0]);

    expect(thread.map((comment) => comment.id)).toEqual([
      deletedWithReplies.id,
    ]);
    expect(thread[0].deleted).toBe(true);
    // A deleted comment carries nothing a Student could edit or read.
    expect(thread[0].body).toBe("");
    expect(thread[0].bodyHtml).toBe("");
    expect(thread[0].editedAt).toBeNull();
    expect(deletedEmpty).toBeDefined();
  });

  it("hides a deleted reply but keeps its live siblings", async () => {
    const question = insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "Question",
    });
    insertComment({
      lessonId: lessonIds[0],
      userId: base.instructor.id,
      body: "Deleted reply",
      parentId: question.id,
      deletedAt: NOW,
    });
    const live = insertComment({
      lessonId: lessonIds[0],
      userId: base.instructor.id,
      body: "Live reply",
      parentId: question.id,
    });

    const thread = await getRenderedThread(db, lessonIds[0]);

    expect(thread[0].replies.map((reply) => reply.id)).toEqual([live.id]);
  });

  it("ignores a reply aimed at another reply — Discussion is one level deep", async () => {
    const question = insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "Question",
    });
    const reply = insertComment({
      lessonId: lessonIds[0],
      userId: base.instructor.id,
      body: "Reply",
      parentId: question.id,
    });
    insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "Grandchild",
      parentId: reply.id,
    });

    const thread = await getRenderedThread(db, lessonIds[0]);

    expect(thread).toHaveLength(1);
    expect(thread[0].replies).toHaveLength(1);
    expect(thread[0].replies[0].replies).toEqual([]);
  });

  it("returns an empty thread for a lesson that does not exist", async () => {
    expect(await getRenderedThread(db, 999)).toEqual([]);
  });

  it("looks a comment up by id", () => {
    const comment = insertComment({
      lessonId: lessonIds[0],
      userId: base.user.id,
      body: "Hello",
    });
    expect(getCommentById(db, comment.id)).toMatchObject({
      lessonId: lessonIds[0],
    });
    expect(getCommentById(db, 999)).toBeUndefined();
  });
});
