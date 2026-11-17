import type { Db } from "./outline.server";
import {
  lessonProgress,
  modules,
  lessons,
  videoWatchEvents,
} from "~/db/schema";
import { LessonProgressStatus } from "~/db/schema";
import { and, desc, eq, or, sql } from "drizzle-orm";

type Progress = typeof lessonProgress.$inferSelect;

/** The Student's progress row on the Lesson, if there is one. */
export function getLessonProgress(
  db: Db,
  userId: number,
  lessonId: number
): Progress | undefined {
  return db
    .select()
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.lessonId, lessonId)
      )
    )
    .get();
}

/**
 * Every lesson in the course keyed to its status for this Student, for the
 * curriculum sidebar's ticks. Lessons without a row are absent from the map.
 * One query for the whole course — never one per lesson.
 */
export function getCourseLessonProgressMap(
  db: Db,
  userId: number,
  courseId: number
): Record<number, string> {
  const courseModules = db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .all();

  if (courseModules.length === 0) return {};

  const courseLessons = db
    .select({ id: lessons.id })
    .from(lessons)
    .where(or(...courseModules.map((mod) => eq(lessons.moduleId, mod.id))))
    .all();

  if (courseLessons.length === 0) return {};

  const rows = db
    .select()
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        or(
          ...courseLessons.map((lesson) =>
            eq(lessonProgress.lessonId, lesson.id)
          )
        )
      )
    )
    .all();

  const map: Record<number, string> = {};
  for (const row of rows) {
    map[row.lessonId] = row.status;
  }

  return map;
}

/** Marks the Lesson complete, creating the progress row if this is the first visit. */
export function markLessonComplete(
  db: Db,
  userId: number,
  lessonId: number,
  now: Date
) {
  const existing = getLessonProgress(db, userId, lessonId);

  if (existing) {
    return db
      .update(lessonProgress)
      .set({
        status: LessonProgressStatus.Completed,
        completedAt: now.toISOString(),
      })
      .where(eq(lessonProgress.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(lessonProgress)
    .values({
      userId,
      lessonId,
      status: LessonProgressStatus.Completed,
      completedAt: now.toISOString(),
    })
    .returning()
    .get();
}

/**
 * Marks the Lesson in progress when it is opened. A completed Lesson never
 * goes back to in progress — revisiting it must not undo the tick.
 */
export function markLessonInProgress(db: Db, userId: number, lessonId: number) {
  const existing = getLessonProgress(db, userId, lessonId);

  if (existing) {
    if (existing.status === LessonProgressStatus.Completed) {
      return existing;
    }
    return db
      .update(lessonProgress)
      .set({ status: LessonProgressStatus.InProgress })
      .where(eq(lessonProgress.id, existing.id))
      .returning()
      .get();
  }

  return db
    .insert(lessonProgress)
    .values({
      userId,
      lessonId,
      status: LessonProgressStatus.InProgress,
    })
    .returning()
    .get();
}

/** The furthest point the Student reached in the video, in seconds. 0 if never played. */
export function getLastWatchPosition(
  db: Db,
  userId: number,
  lessonId: number
): number {
  const lastEvent = db
    .select()
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        eq(videoWatchEvents.lessonId, lessonId)
      )
    )
    .orderBy(desc(videoWatchEvents.createdAt))
    .limit(1)
    .get();

  return lastEvent?.positionSeconds ?? 0;
}

/** The furthest watch position as a percentage of the video, clamped to 100. */
export function calculateWatchProgress(
  db: Db,
  watch: {
    userId: number;
    lessonId: number;
    videoDurationSeconds: number;
  }
) {
  if (watch.videoDurationSeconds <= 0) return 0;

  const result = db
    .select({ maxPos: sql<number>`max(${videoWatchEvents.positionSeconds})` })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, watch.userId),
        eq(videoWatchEvents.lessonId, watch.lessonId)
      )
    )
    .get();

  const maxPosition = result?.maxPos ?? 0;

  return Math.min(
    Math.round((maxPosition / watch.videoDurationSeconds) * 100),
    100
  );
}
