import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./saved.server";
import {
  approveRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";
import { fakeNotifications } from "./notifications.fake.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);
const LATER = new Date(2026, 9, 7, 12, 0, 0);
const EVEN_LATER = new Date(2026, 9, 8, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];
let otherCourseLessonId: number;
let notifications: ReturnType<typeof fakeNotifications>;

beforeEach(() => {
  db = createTestDb();
  notifications = fakeNotifications();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );

  // A lesson in a different course, so a Saved row can be checked on its
  // course, not just its lesson.
  const otherCourse = db
    .insert(schema.courses)
    .values({
      title: "Other Course",
      slug: "other-course",
      description: "Another test course",
      salesCopy: "## Other Course",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
  const otherModule = db
    .insert(schema.modules)
    .values({ courseId: otherCourse.id, title: "Extras", position: 1 })
    .returning()
    .get();
  otherCourseLessonId = db
    .insert(schema.lessons)
    .values({
      moduleId: otherModule.id,
      title: "Lesson elsewhere",
      position: 1,
    })
    .returning()
    .get().id;
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function bookmarkAt(userId: number, lessonId: number, createdAt: string) {
  db.insert(schema.bookmarks)
    .values({ userId, lessonId, createdAt })
    .run();
}

describe("toggling a bookmark", () => {
  it("flags a Lesson that is not bookmarked", () => {
    expect(toggleBookmark(db, base.user.id, lessonIds[0])).toBe(true);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(true);
  });

  it("unflags the Lesson when toggled again", () => {
    toggleBookmark(db, base.user.id, lessonIds[0]);

    expect(toggleBookmark(db, base.user.id, lessonIds[0])).toBe(false);
    expect(isBookmarked(db, base.user.id, lessonIds[0])).toBe(false);
  });

  it("keeps one Bookmark per Student per Lesson, enforced by the database", () => {
    toggleBookmark(db, base.user.id, lessonIds[0]);

    expect(() =>
      db.insert(schema.bookmarks)
        .values({ userId: base.user.id, lessonId: lessonIds[0] })
        .run()
    ).toThrow();
  });
});

describe("saving a note", () => {
  it("creates a Note with the body trimmed", () => {
    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "  First thought.  ",
      NOW
    );

    expect(result).toMatchObject({
      ok: true,
      note: {
        userId: base.user.id,
        lessonId: lessonIds[0],
        body: "First thought.",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
  });

  it("replaces the body and moves the last-edited time on, keeping createdAt", () => {
    saveNote(db, base.user.id, lessonIds[0], "First thought.", NOW);

    const result = saveNote(
      db,
      base.user.id,
      lessonIds[0],
      "Second thought.",
      LATER
    );

    expect(result).toMatchObject({
      ok: true,
      note: {
        body: "Second thought.",
        createdAt: NOW.toISOString(),
        updatedAt: LATER.toISOString(),
      },
    });
  });

  it("refuses a Note over 2000 characters", () => {
    expect(
      saveNote(db, base.user.id, lessonIds[0], "a".repeat(2001), NOW)
    ).toEqual({ ok: false, error: "Note must be 2000 characters or fewer" });
    expect(getNote(db, base.user.id, lessonIds[0])).toBeUndefined();
  });

  it("accepts a Note of exactly 2000 characters", () => {
    expect(
      saveNote(db, base.user.id, lessonIds[0], "a".repeat(2000), NOW)
    ).toMatchObject({ ok: true, note: { body: "a".repeat(2000) } });
  });

  it("keeps one Note per Student per Lesson, enforced by the database", () => {
    saveNote(db, base.user.id, lessonIds[0], "First thought.", NOW);

    expect(() =>
      db.insert(schema.notes)
        .values({
          userId: base.user.id,
          lessonId: lessonIds[0],
          body: "Second copy.",
        })
        .run()
    ).toThrow();
  });
});

describe("the Saved lists", () => {
  it("contain only that Student's rows", () => {
    const ben = addStudent("Ben");
    toggleBookmark(db, base.user.id, lessonIds[0]);
    toggleBookmark(db, ben.id, lessonIds[1]);
    saveNote(db, base.user.id, lessonIds[1], "My note.", NOW);
    saveNote(db, ben.id, lessonIds[0], "Ben's note.", NOW);

    expect(
      listBookmarks(db, base.user.id).map((row) => row.lessonId)
    ).toEqual([lessonIds[0]]);
    expect(listNotes(db, base.user.id).map((row) => row.body)).toEqual([
      "My note.",
    ]);
  });

  it("list Bookmarks newest first", () => {
    bookmarkAt(base.user.id, lessonIds[0], NOW.toISOString());
    bookmarkAt(base.user.id, lessonIds[1], LATER.toISOString());

    expect(listBookmarks(db, base.user.id).map((row) => row.lessonId)).toEqual(
      [lessonIds[1], lessonIds[0]]
    );
  });

  it("list Notes newest-edited first", () => {
    saveNote(db, base.user.id, lessonIds[0], "Older edit.", NOW);
    saveNote(db, base.user.id, lessonIds[1], "Newer edit.", LATER);

    expect(listNotes(db, base.user.id).map((row) => row.body)).toEqual([
      "Newer edit.",
      "Older edit.",
    ]);
  });

  it("carry the Lesson and Course each row belongs to", () => {
    toggleBookmark(db, base.user.id, otherCourseLessonId);
    saveNote(db, base.user.id, otherCourseLessonId, "Elsewhere.", NOW);

    expect(listBookmarks(db, base.user.id)).toEqual([
      {
        id: expect.any(Number),
        createdAt: expect.any(String),
        lessonId: otherCourseLessonId,
        lessonTitle: "Lesson elsewhere",
        moduleTitle: "Extras",
        courseTitle: "Other Course",
        courseSlug: "other-course",
      },
    ]);
    expect(listNotes(db, base.user.id)).toEqual([
      {
        id: expect.any(Number),
        body: "Elsewhere.",
        updatedAt: NOW.toISOString(),
        lessonId: otherCourseLessonId,
        lessonTitle: "Lesson elsewhere",
        moduleTitle: "Extras",
        courseTitle: "Other Course",
        courseSlug: "other-course",
      },
    ]);
  });
});

describe("approving a Refund", () => {
  it("keeps the Student's Bookmarks and Notes in place", async () => {
    const platformAdmin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: NOW.toISOString(),
      })
      .returning()
      .get();
    db.insert(schema.enrollments)
      .values({ userId: base.user.id, courseId: base.course.id })
      .run();
    toggleBookmark(db, base.user.id, lessonIds[0]);
    saveNote(db, base.user.id, lessonIds[1], "Still mine.", EVEN_LATER);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "It was not what I expected.",
      EVEN_LATER,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const approved = await approveRefundRequest(
      db,
      raised.refundRequestId,
      platformAdmin.id,
      null,
      EVEN_LATER,
      notifications
    );
    if (!approved.ok) throw new Error("Refund was not approved");

    expect(
      db
        .select()
        .from(schema.bookmarks)
        .where(
          and(
            eq(schema.bookmarks.userId, base.user.id),
            eq(schema.bookmarks.lessonId, lessonIds[0])
          )
        )
        .all()
    ).toHaveLength(1);
    expect(getNote(db, base.user.id, lessonIds[1])).toMatchObject({
      body: "Still mine.",
    });
    expect(
      listBookmarks(db, base.user.id).map((row) => row.lessonId)
    ).toEqual([lessonIds[0]]);
    expect(listNotes(db, base.user.id).map((row) => row.body)).toEqual([
      "Still mine.",
    ]);
  });
});
