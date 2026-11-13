import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import { MAX_NOTE_LENGTH } from "~/lib/notes";

// ─── Bookmarks and Notes ───
// A Student's Bookmark on a Lesson, and their Note about it. Both are private
// to the Student who made them — no other view reads them. See GLOSSARY.md for
// the language.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

export type Db = BetterSQLite3Database<typeof schema>;

type Note = typeof notes.$inferSelect;

/** The Lesson, Module and Course a Saved row points at, selected as one join. */
const lessonRef = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  moduleTitle: modules.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

function getBookmarkRow(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId)))
    .get();
}

/**
 * Toggles the Student's Bookmark on a Lesson, and returns whether the Lesson
 * is now bookmarked. The database's unique (user, lesson) index is what keeps
 * this at one Bookmark, not this read-then-write.
 */
export function toggleBookmark(db: Db, userId: number, lessonId: number) {
  const existing = getBookmarkRow(db, userId, lessonId);

  if (existing) {
    db.delete(bookmarks).where(eq(bookmarks.id, existing.id)).run();
    return false;
  }

  db.insert(bookmarks).values({ userId, lessonId }).run();
  return true;
}

export function isBookmarked(db: Db, userId: number, lessonId: number) {
  return !!getBookmarkRow(db, userId, lessonId);
}

export function getNote(db: Db, userId: number, lessonId: number) {
  return db
    .select()
    .from(notes)
    .where(and(eq(notes.userId, userId), eq(notes.lessonId, lessonId)))
    .get();
}

export type SaveNoteResult =
  | { ok: true; note: Note }
  | { ok: false; error: string };

/**
 * Saves the Student's Note on a Lesson. Saving again replaces the body and
 * moves the "last edited" time on; `createdAt` keeps its first value. The body
 * is trimmed and stored as plain text.
 */
export function saveNote(
  db: Db,
  userId: number,
  lessonId: number,
  body: string,
  now: Date
): SaveNoteResult {
  const trimmed = body.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    return {
      ok: false,
      error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer`,
    };
  }

  const existing = getNote(db, userId, lessonId);

  if (existing) {
    const note = db
      .update(notes)
      .set({ body: trimmed, updatedAt: now.toISOString() })
      .where(eq(notes.id, existing.id))
      .returning()
      .get();
    return { ok: true, note };
  }

  const note = db
    .insert(notes)
    .values({
      userId,
      lessonId,
      body: trimmed,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .returning()
    .get();
  return { ok: true, note };
}

/**
 * The Student's Bookmarks for the Saved page, newest first, each joined to its
 * Lesson and Course so a row can link to the Lesson and name the Course.
 */
export function listBookmarks(db: Db, userId: number) {
  return db
    .select({ id: bookmarks.id, createdAt: bookmarks.createdAt, ...lessonRef })
    .from(bookmarks)
    .innerJoin(lessons, eq(lessons.id, bookmarks.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt))
    .all();
}

/**
 * The Student's Notes for the Saved page, newest-edited first, each joined to
 * its Lesson and Course so a row can link to the Lesson and name the Course.
 */
export function listNotes(db: Db, userId: number) {
  return db
    .select({
      id: notes.id,
      body: notes.body,
      updatedAt: notes.updatedAt,
      ...lessonRef,
    })
    .from(notes)
    .innerJoin(lessons, eq(lessons.id, notes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt))
    .all();
}
