import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { plainText } from "~/lib/text";
import { setCurrentUserId } from "~/lib/session";
import { listBookmarks } from "~/lib/bookmarks.server";
import { listNotes } from "~/lib/notes.server";
import { createAccess } from "../index.server";

// The Saved page (/saved) across the Access seam. The page is
// sign-in-only, and everything on it is the signed-in student's own — the
// guard's user id scopes both listings — so that is what this file pins.
// The routes bind the singleton; these tests pin the same contract through
// the factory's test-db adapter.
//
// Nothing here may drift from app/modules/access/tests/access.test.ts's
// guard matrix; these tests exist to name the route's contract, not to
// re-pin the guards in the abstract.

let db: TestDb;
let student: typeof schema.users.$inferSelect;
let otherStudent: typeof schema.users.$inferSelect;
let course: typeof schema.courses.$inferSelect;
let studentLesson: typeof schema.lessons.$inferSelect;
let otherStudentLesson: typeof schema.lessons.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  const base = seedBaseData(db);
  student = base.user;
  course = base.course;
  otherStudent = addUser("Olive Other");
  studentLesson = addLesson("For the student");
  otherStudentLesson = addLesson("For the other student");

  // Each student has flagged and noted a different lesson.
  db.insert(schema.bookmarks)
    .values({ userId: student.id, lessonId: studentLesson.id })
    .run();
  db.insert(schema.bookmarks)
    .values({ userId: otherStudent.id, lessonId: otherStudentLesson.id })
    .run();
  db.insert(schema.notes)
    .values({
      userId: student.id,
      lessonId: studentLesson.id,
      body: plainText("Mine"),
    })
    .run();
  db.insert(schema.notes)
    .values({
      userId: otherStudent.id,
      lessonId: otherStudentLesson.id,
      body: plainText("Theirs"),
    })
    .run();
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

function addLesson(title: string) {
  const module_ = db
    .insert(schema.modules)
    .values({ courseId: course.id, title, position: 1 })
    .returning()
    .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: module_.id, title, position: 1 })
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

// The guard throws the value `data(message, { status })` builds; the route
// hierarchy's error handling shows `status` and `data`, so those are what
// the tests pin.
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { data: unknown; init: { status?: number } };
  }
  throw new Error("Expected the guard to throw, but it returned");
}

// The route, as it runs: the guard's user id scopes both listings.
async function loader(request: Request) {
  const userId = await createAccess(db).requireUserId(request);
  return {
    savedBookmarks: listBookmarks(db, userId),
    savedNotes: listNotes(db, userId),
  };
}

describe("the saved loader", () => {
  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireUserId(await requestAs(null))
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });

  it("lists only the signed-in student's own bookmarks and notes", async () => {
    const data = await loader(await requestAs(student.id));

    expect(data.savedBookmarks).toHaveLength(1);
    expect(data.savedBookmarks[0].lesson.id).toBe(studentLesson.id);
    expect(data.savedNotes).toHaveLength(1);
    expect(data.savedNotes[0].lesson.id).toBe(studentLesson.id);
    expect(data.savedNotes[0].body).toBe("Mine");
  });

  it("lists the other student's page to them, and not to anyone else", async () => {
    const data = await loader(await requestAs(otherStudent.id));

    expect(data.savedBookmarks[0].lesson.id).toBe(otherStudentLesson.id);
    expect(data.savedNotes[0].body).toBe("Theirs");
  });
});
