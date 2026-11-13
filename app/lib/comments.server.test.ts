import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createComment, getCommentById } from "./comments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  const lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
  lessonId = lessonIds[0];
  otherLessonId = lessonIds[1];
});

describe("creating a comment", () => {
  it("creates a Discussion Question with a trimmed body", () => {
    const result = createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "  Is this the right lesson?  ",
      NOW
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.comment).toMatchObject({
      userId: base.user.id,
      lessonId,
      parentId: null,
      body: "Is this the right lesson?",
      createdAt: NOW.toISOString(),
    });
    expect(result.course).toMatchObject({
      courseId: base.course.id,
      courseTitle: base.course.title,
      courseSlug: base.course.slug,
      instructorId: base.instructor.id,
    });
    expect(result.parentAuthorId).toBe(null);
    expect(getCommentById(db, result.comment.id)?.body).toBe(
      "Is this the right lesson?"
    );
  });

  it("rejects an empty comment", () => {
    const result = createComment(db, base.user.id, lessonId, null, "   ", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment cannot be empty",
    });
  });

  it("rejects a comment over the length limit", () => {
    const result = createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "a".repeat(5001),
      NOW
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment must be 5000 characters or fewer",
    });
  });

  it("rejects a lesson that belongs to no course", () => {
    const result = createComment(
      db,
      base.user.id,
      lessonId + 1000,
      null,
      "Hi",
      NOW
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Lesson not found",
    });
  });

  it("creates a Discussion Reply and reports the question's author", () => {
    const question = createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW
    );
    if (!question.ok) throw new Error(question.error);

    const result = createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Start at the top.",
      NOW
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.comment).toMatchObject({
      userId: base.instructor.id,
      lessonId,
      parentId: question.comment.id,
      body: "Start at the top.",
    });
    expect(result.parentAuthorId).toBe(base.user.id);
  });

  it("rejects a reply to a comment that doesn't exist", () => {
    const result = createComment(db, base.user.id, lessonId, 9999, "Hi", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Parent comment not found",
    });
  });

  it("rejects a reply to a comment on another lesson", () => {
    const question = createComment(
      db,
      base.user.id,
      otherLessonId,
      null,
      "Question elsewhere",
      NOW
    );
    if (!question.ok) throw new Error(question.error);

    const result = createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Wrong thread",
      NOW
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Parent comment belongs to a different lesson",
    });
  });

  it("rejects a reply to a reply", () => {
    const question = createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW
    );
    if (!question.ok) throw new Error(question.error);
    const reply = createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Start at the top.",
      NOW
    );
    if (!reply.ok) throw new Error(reply.error);

    const result = createComment(
      db,
      base.user.id,
      lessonId,
      reply.comment.id,
      "But what about...",
      NOW
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Replies can only be one level deep",
    });
  });
});
