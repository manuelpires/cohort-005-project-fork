import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import { markdown } from "~/lib/text";
import { createAccess } from "../index.server";
import { createInstructorAnalytics } from "../../instructor-analytics/index.server";

// The instructor analytics page (/instructor/analytics) across the Access
// seam. The route is one composition — the guard's viewer goes straight
// into the analytics service — so that composition is what this file pins:
// an instructor sees revenue from their own courses only, a Platform Admin
// sees the whole platform, and everyone else is turned away. The guard
// returns exactly the viewer the service takes; there is no user row to
// drop on the floor.
//
// Nothing here may drift from app/modules/access/tests/access.test.ts's
// guard matrix; these tests exist to name the route's contract, not to
// re-pin the guards in the abstract.

// Noon UTC keeps fixture dates on one calendar day, like the analytics
// module's own tests.
const NOW = new Date("2026-11-14T12:00:00.000Z");
const DAY_MS = 86_400_000;

let db: TestDb;
let buyer: typeof schema.users.$inferSelect;
let instructor: typeof schema.users.$inferSelect;
let admin: typeof schema.users.$inferSelect;
let course: typeof schema.courses.$inferSelect;
let otherCourse: typeof schema.courses.$inferSelect;
let categoryId: number;

beforeEach(() => {
  db = createTestDb();
  const base = seedBaseData(db);
  buyer = base.user;
  instructor = base.instructor;
  course = base.course;
  categoryId = base.category.id;
  admin = addUser("Pat Admin", UserRole.Admin);

  const otherInstructor = addUser("Olive Other", UserRole.Instructor);
  otherCourse = addCourse(otherInstructor.id, "Other Course");

  // One sale on each course, both inside the default 30-day range.
  buy(buyer.id, course.id, 5000);
  buy(buyer.id, otherCourse.id, 3000);
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

function addCourse(instructorId: number, title: string) {
  return db
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replaceAll(" ", "-"),
      description: title,
      salesCopy: markdown(title),
      instructorId,
      categoryId,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

function buy(userId: number, courseId: number, amountPaid: number) {
  db.insert(schema.purchases)
    .values({
      userId,
      courseId,
      amountPaid,
      country: "US",
      createdAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
    })
    .run();
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

// The route, as it runs: the guard's viewer, straight into the service.
async function loader(request: Request) {
  const viewer = await createAccess(db).requireInstructorOrAdmin(request);
  return createInstructorAnalytics(db).get(viewer, new URLSearchParams(), NOW);
}

describe("the analytics loader", () => {
  it("scopes an instructor to revenue from their own courses", async () => {
    const data = await loader(await requestAs(instructor.id));

    expect(data.summary.grossCents).toBe(5000);
    expect(data.summary.purchaseCount).toBe(1);
  });

  it("spans every course for a Platform Admin", async () => {
    const data = await loader(await requestAs(admin.id));

    expect(data.summary.grossCents).toBe(8000);
    expect(data.summary.purchaseCount).toBe(2);
  });

  it("throws 403 for a Student", async () => {
    const error = await rejection(loader(await requestAs(buyer.id)));

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only instructors can access this page.");
  });

  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(loader(await requestAs(null)));

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });
});
