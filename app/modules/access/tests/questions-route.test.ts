import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole, comments } from "~/db/schema";
import { markdown } from "~/lib/text";
import { setCurrentUserId } from "~/lib/session";
import { createComment } from "~/lib/comments.server";
import { loggingNotifications } from "~/lib/notifications.server";
import { createAccess } from "../index.server";

// The instructor questions page (/instructor/questions) across the Access
// seam. The routes bind the singleton; these tests pin the same contract
// through the factory's test-db adapter. The loader's question listing runs
// against the app database inside the route file, so what this file pins are
// the two things the seam decides for it: who may list at all, and the
// viewer the listing scopes by — an instructor's own courses, every course
// for an admin. The action's answering permission is pinned end to end,
// guard to posted reply.
//
// Nothing here may drift from app/modules/access/tests/access.test.ts's
// guard matrix; these tests exist to name the routes' contracts, not to
// re-pin the guards in the abstract.

let db: TestDb;
let student: typeof schema.users.$inferSelect;
let instructor: typeof schema.users.$inferSelect;
let otherInstructor: typeof schema.users.$inferSelect;
let admin: typeof schema.users.$inferSelect;
let category: typeof schema.categories.$inferSelect;
let course: typeof schema.courses.$inferSelect;
let lesson: typeof schema.lessons.$inferSelect;
let question: typeof schema.comments.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  const base = seedBaseData(db);
  student = base.user;
  instructor = base.instructor;
  category = base.category;
  course = base.course;
  otherInstructor = addUser("Olive Other", UserRole.Instructor);
  admin = addUser("Pat Admin", UserRole.Admin);

  const module_ = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "Module 1", position: 1 })
    .returning()
    .get();
  lesson = db
    .insert(schema.lessons)
    .values({ moduleId: module_.id, title: "Lesson 1", position: 1 })
    .returning()
    .get();
  question = db
    .insert(schema.comments)
    .values({
      lessonId: lesson.id,
      userId: student.id,
      parentId: null,
      body: markdown("How do I start?"),
      createdAt: new Date().toISOString(),
      deletedAt: null,
    })
    .returning()
    .get();
});

// ─── Fixtures ───
// Rows go in directly, and session cookies are forged through the session
// module's own interface — the same signing the DevUI's switch-user flow
// uses — so no module is mocked.

function addUser(name: string, role = schema.UserRole.Student) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
      role,
    })
    .returning()
    .get();
}

async function requestAs(userId: number | null): Promise<Request> {
  if (userId === null) return new Request("http://localhost:3000");
  const scratch = new Request("http://localhost:3000");
  const setCookie = await setCurrentUserId(scratch, userId);
  const cookie = setCookie.split(";")[0];
  return new Request("http://localhost:3000", { headers: { Cookie: cookie } });
}

// The guards throw the value `data(message, { status })` builds; the page's
// ErrorBoundary shows `status` and `data`, so those are what the tests pin.
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { data: unknown; init: { status?: number } };
  }
  throw new Error("Expected the guard to throw, but it returned");
}

describe("the questions loader", () => {
  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireInstructorOrAdmin(await requestAs(null))
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });

  it("throws 403 for a Student", async () => {
    const error = await rejection(
      createAccess(db).requireInstructorOrAdmin(await requestAs(student.id))
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only instructors can access this page.");
  });

  it("admits an instructor as the scope that lists only their own courses", async () => {
    const viewer = await createAccess(db).requireInstructorOrAdmin(
      await requestAs(instructor.id)
    );

    expect(viewer).toEqual({ userId: instructor.id, isAdmin: false });
  });

  it("admits an admin as the scope that lists every course", async () => {
    const viewer = await createAccess(db).requireInstructorOrAdmin(
      await requestAs(admin.id)
    );

    expect(viewer).toEqual({ userId: admin.id, isAdmin: true });
  });
});

describe("answering a question", () => {
  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireStaff(await requestAs(null), course.id)
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });

  it("throws 403 for a Student", async () => {
    const error = await rejection(
      createAccess(db).requireStaff(await requestAs(student.id), course.id)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only this course's instructor can do that.");
  });

  it("throws 403 for an instructor who doesn't own the course", async () => {
    const error = await rejection(
      createAccess(db).requireStaff(
        await requestAs(otherInstructor.id),
        course.id
      )
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only this course's instructor can do that.");
  });

  it("lets the course's own instructor post the reply, authored by them", async () => {
    // The action, as the route runs it: the staff guard's userId is the
    // reply's author.
    const { userId: authorId } = await createAccess(db).requireStaff(
      await requestAs(instructor.id),
      course.id
    );
    const created = await createComment(
      db,
      authorId,
      question.lessonId,
      question.id,
      "You start by opening the first lesson.",
      new Date(),
      loggingNotifications()
    );

    expect(created.ok).toBe(true);
    const reply = db
      .select()
      .from(comments)
      .where(eq(comments.parentId, question.id))
      .get();
    expect(reply?.userId).toBe(instructor.id);
  });

  it("lets a Platform Admin answer too, as themselves", async () => {
    const { userId: authorId } = await createAccess(db).requireStaff(
      await requestAs(admin.id),
      course.id
    );

    expect(authorId).toBe(admin.id);
  });
});
