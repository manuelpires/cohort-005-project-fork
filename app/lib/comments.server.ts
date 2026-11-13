import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments, courses, lessons, modules } from "~/db/schema";
import { validateCommentBody } from "~/lib/comments";

// ─── Comments ───
// Writing the lesson discussion: a comment is either a Discussion Question
// (top-level) or a Discussion Reply (one level deep). See GLOSSARY.md for the
// language.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Db = BetterSQLite3Database<typeof schema>;

export function getCommentById(db: Db, commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

export type LessonCourse = {
  courseId: number;
  courseTitle: string;
  courseSlug: string;
  instructorId: number;
};

export function getCourseForLesson(
  db: Db,
  lessonId: number
): LessonCourse | undefined {
  return db
    .select({
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(lessons.id, lessonId))
    .get();
}

export type CreateCommentResult =
  | {
      ok: true;
      comment: typeof comments.$inferSelect;
      course: LessonCourse;
      parentAuthorId: number | null;
    }
  | { ok: false; status: 400 | 404; error: string };

export function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date
): CreateCommentResult {
  const validated = validateCommentBody(body);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }
  const trimmed = validated.trimmed;

  const course = getCourseForLesson(db, lessonId);
  if (!course) {
    return { ok: false, status: 404, error: "Lesson not found" };
  }

  // A reply must hang off a top-level comment of the same lesson — replies
  // are one level deep only.
  let parentAuthorId: number | null = null;
  if (parentId !== null) {
    const parent = getCommentById(db, parentId);
    if (!parent) {
      return { ok: false, status: 404, error: "Parent comment not found" };
    }
    if (parent.lessonId !== lessonId) {
      return {
        ok: false,
        status: 404,
        error: "Parent comment belongs to a different lesson",
      };
    }
    if (parent.parentId !== null) {
      return {
        ok: false,
        status: 400,
        error: "Replies can only be one level deep",
      };
    }
    parentAuthorId = parent.userId;
  }

  const comment = db
    .insert(comments)
    .values({
      userId,
      lessonId,
      parentId,
      body: trimmed,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();

  return { ok: true, comment, course, parentAuthorId };
}
