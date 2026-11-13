import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { comments, courses, lessons, modules, users } from "~/db/schema";
import { validateCommentBody } from "~/lib/comments";
import {
  archiveCommentNotifications,
  defaultNotificationsPort,
  triggerNotification,
  type NotificationsPort,
} from "~/lib/notifications.server";

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
  lessonTitle: string;
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
      lessonTitle: lessons.title,
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

// Notifications are a snapshot of the moment the comment was posted: the
// snippet stops at 80 characters, and editing the comment later never
// rewrites what was sent.
const SNIPPET_LENGTH = 80;

function commentSnippet(body: string) {
  return body.slice(0, SNIPPET_LENGTH);
}

function notificationUser(db: Db, id: number | undefined) {
  if (id === undefined) return undefined;
  return db.select().from(users).where(eq(users.id, id)).get();
}

// ─── Discussion Notifications ───
// A Discussion Question from anyone except the course's Instructor — Platform
// Admins included — notifies the Instructor. A Discussion Reply from someone
// other than the question's author notifies the author only. Own actions
// never notify the actor. Both triggers are best-effort and fire only after
// the comment row is written.
async function notifyCommentCreated(
  db: Db,
  result: Extract<CreateCommentResult, { ok: true }>,
  notifications: NotificationsPort
): Promise<void> {
  const { comment, course, parentAuthorId } = result;
  const author = notificationUser(db, comment.userId);
  if (!author) return;

  const data = {
    commentId: comment.id,
    lessonTitle: course.lessonTitle,
    snippet: commentSnippet(comment.body),
    url: `/courses/${course.courseSlug}/lessons/${comment.lessonId}#comment-${comment.id}`,
  };

  if (parentAuthorId === null) {
    if (comment.userId === course.instructorId) return;
    const instructor = notificationUser(db, course.instructorId);
    if (!instructor) return;
    await triggerNotification(
      {
        workflow: "discussion-question-created",
        recipients: [instructor],
        actor: author,
        data: { kind: "discussion-question", ...data },
        idempotencyKey: `discussion-question-created:${comment.id}`,
      },
      notifications
    );
    return;
  }

  if (comment.userId === parentAuthorId) return;
  const parentAuthor = notificationUser(db, parentAuthorId);
  if (!parentAuthor) return;
  await triggerNotification(
    {
      workflow: "discussion-reply-created",
      recipients: [parentAuthor],
      actor: author,
      data: { kind: "discussion-reply", ...data },
      idempotencyKey: `discussion-reply-created:${comment.id}`,
    },
    notifications
  );
}

export async function createComment(
  db: Db,
  userId: number,
  lessonId: number,
  parentId: number | null,
  body: string,
  now: Date,
  notifications: NotificationsPort = defaultNotificationsPort()
): Promise<CreateCommentResult> {
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

  const result: Extract<CreateCommentResult, { ok: true }> = {
    ok: true,
    comment,
    course,
    parentAuthorId,
  };
  await notifyCommentCreated(db, result, notifications);
  return result;
}

export type DeleteCommentResult =
  | { ok: true; comment: typeof comments.$inferSelect }
  | { ok: false; status: 403 | 404; error: string };

// Soft-deletes a comment: the row stays (replies remain visible under a
// deleted question), and the Notifications the comment caused are archived
// out of their recipients' feeds. Deleting a Discussion Question leaves its
// Reply Notifications in place — each reply's Notification carries the
// reply's own comment id.
export async function deleteComment(
  db: Db,
  commentId: number,
  userId: number,
  isStaff: boolean,
  now: Date,
  notifications: NotificationsPort = defaultNotificationsPort()
): Promise<DeleteCommentResult> {
  const existing = getCommentById(db, commentId);
  if (!existing) {
    return { ok: false, status: 404, error: "Comment not found" };
  }
  if (existing.userId !== userId && !isStaff) {
    return {
      ok: false,
      status: 403,
      error: "You can only delete your own comments",
    };
  }

  let comment = existing;
  if (existing.deletedAt === null) {
    comment = db
      .update(comments)
      .set({ deletedAt: now.toISOString() })
      .where(eq(comments.id, commentId))
      .returning()
      .get();
  }

  // Best-effort, after the write commits. Runs even for an already-deleted
  // comment, so a delete that followed a failed archive retries it.
  await archiveCommentNotifications(commentId, notifications);
  return { ok: true, comment };
}
