import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { categories, courses, lessons, modules, users } from "~/db/schema";
import { eq, or } from "drizzle-orm";

export type Db = BetterSQLite3Database<typeof schema>;

function courseRow(db: Db, courseId: number) {
  return db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      description: courses.description,
      salesCopy: courses.salesCopy,
      instructorId: courses.instructorId,
      categoryId: courses.categoryId,
      status: courses.status,
      coverImageUrl: courses.coverImageUrl,
      price: courses.price,
      pppEnabled: courses.pppEnabled,
      createdAt: courses.createdAt,
      updatedAt: courses.updatedAt,
      instructorName: users.name,
      instructorAvatarUrl: users.avatarUrl,
      instructorBio: users.bio,
      categoryName: categories.name,
    })
    .from(courses)
    .innerJoin(users, eq(courses.instructorId, users.id))
    .innerJoin(categories, eq(courses.categoryId, categories.id))
    .where(eq(courses.id, courseId))
    .get();
}

/**
 * The course named by its id, every one of its modules in position order,
 * and each module's lessons in position order. This is the shape the
 * curriculum sidebar and the prev/next navigation are built from.
 */
export function getCourseOutline(db: Db, courseId: number) {
  const course = courseRow(db, courseId);
  if (!course) return null;

  const courseModules = db
    .select()
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position)
    .all();

  const moduleIds = courseModules.map((mod) => mod.id);

  const courseLessons =
    moduleIds.length > 0
      ? db
          .select()
          .from(lessons)
          .where(or(...moduleIds.map((id) => eq(lessons.moduleId, id))))
          .orderBy(lessons.position)
          .all()
      : [];

  return {
    ...course,
    modules: courseModules.map((mod) => ({
      ...mod,
      lessons: courseLessons.filter((lesson) => lesson.moduleId === mod.id),
    })),
  };
}

export function getLesson(db: Db, lessonId: number) {
  return db.select().from(lessons).where(eq(lessons.id, lessonId)).get();
}

export function getModule(db: Db, moduleId: number) {
  return db.select().from(modules).where(eq(modules.id, moduleId)).get();
}

export function getUser(db: Db, userId: number) {
  return db.select().from(users).where(eq(users.id, userId)).get();
}

/**
 * The lessons either side of this one in the course's flattened outline,
 * for the Previous / Next navigation. Either side may be missing at the
 * ends of the course. Takes the outline the caller already holds — the
 * neighbours are a walk over it, not a second query.
 */
export function getLessonNeighbours(
  outline: NonNullable<ReturnType<typeof getCourseOutline>>,
  lessonId: number
) {
  const flat = outline.modules.flatMap((mod) =>
    mod.lessons.map((lesson) => ({ id: lesson.id, title: lesson.title }))
  );
  const index = flat.findIndex((lesson) => lesson.id === lessonId);

  return {
    prevLesson: index > 0 ? flat[index - 1] : null,
    nextLesson: index >= 0 && index < flat.length - 1 ? flat[index + 1] : null,
  };
}
