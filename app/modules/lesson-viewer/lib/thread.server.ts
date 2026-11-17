import type { Markdown } from "~/lib/text";
import { markdown } from "~/lib/text";
import {
  UserRole,
  comments,
  courses,
  lessons,
  modules,
  users,
} from "~/db/schema";
import { renderComment } from "~/lib/comment-markdown.server";
import { asc, eq } from "drizzle-orm";
import type { Db } from "./outline.server";

export type CommentAuthor = {
  id: number;
  name: string;
  avatarUrl: string | null;
  isInstructor: boolean;
  isPlatformAdmin: boolean;
};

export type ThreadComment = {
  id: number;
  body: Markdown;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  author: CommentAuthor;
  replies: ThreadComment[];
};

/**
 * A comment as the Discussion renders it: the raw body kept only so the edit
 * box can refill it, and the sanitised HTML the page actually shows. Bodies
 * arrive pre-rendered from the server, because comments are untrusted input
 * and the sanitising renderer is server-only.
 */
export type RenderedComment = {
  id: number;
  body: string;
  bodyHtml: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  author: CommentAuthor;
  replies: RenderedComment[];
};

export function getCommentById(db: Db, commentId: number) {
  return db.select().from(comments).where(eq(comments.id, commentId)).get();
}

function getCourseForLesson(db: Db, lessonId: number) {
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

type CommentRow = {
  id: number;
  body: typeof comments.$inferSelect.body;
  parentId: number | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  authorId: number;
  authorName: string;
  authorAvatarUrl: string | null;
  authorRole: typeof users.$inferSelect.role;
};

function toComment(row: CommentRow, instructorId: number): ThreadComment {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    body: deleted ? markdown("") : row.body,
    createdAt: row.createdAt,
    editedAt: deleted ? null : row.editedAt,
    deleted,
    author: {
      id: row.authorId,
      name: row.authorName,
      avatarUrl: row.authorAvatarUrl,
      isInstructor: row.authorId === instructorId,
      isPlatformAdmin: row.authorRole === UserRole.Admin,
    },
    replies: [],
  };
}

function getLessonThread(db: Db, lessonId: number): ThreadComment[] {
  const course = getCourseForLesson(db, lessonId);
  if (!course) return [];

  const rows = db
    .select({
      id: comments.id,
      body: comments.body,
      parentId: comments.parentId,
      createdAt: comments.createdAt,
      editedAt: comments.editedAt,
      deletedAt: comments.deletedAt,
      authorId: users.id,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
      authorRole: users.role,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.lessonId, lessonId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();

  const toThreadComment = (row: (typeof rows)[number]): ThreadComment =>
    toComment(row, course.instructorId);

  const topLevel: ThreadComment[] = [];
  const byId = new Map<number, ThreadComment>();

  for (const row of rows) {
    if (row.parentId !== null) continue;
    const comment = toThreadComment(row);
    byId.set(comment.id, comment);
    topLevel.push(comment);
  }

  for (const row of rows) {
    if (row.parentId === null || row.deletedAt !== null) continue;
    byId.get(row.parentId)?.replies.push(toThreadComment(row));
  }

  // A deleted question with no replies left has nothing worth showing.
  return topLevel.filter(
    (comment) => !comment.deleted || comment.replies.length > 0
  );
}

/**
 * Renders every comment body to sanitised HTML, preserving the reply nesting.
 * Comments are untrusted input, so this must be renderComment — never
 * renderMarkdown, which lets raw HTML through for trusted lesson content.
 */
function renderThread(nodes: ThreadComment[]): Promise<RenderedComment[]> {
  return Promise.all(
    nodes.map(async (node) => ({
      ...node,
      bodyHtml: node.deleted ? "" : await renderComment(node.body),
      replies: await renderThread(node.replies),
    }))
  );
}

/** The Lesson's Discussion, questions with their replies, bodies pre-rendered. */
export function getRenderedThread(
  db: Db,
  lessonId: number
): Promise<RenderedComment[]> {
  return renderThread(getLessonThread(db, lessonId));
}
