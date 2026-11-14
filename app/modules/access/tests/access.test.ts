import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { markdown } from "~/lib/text";
import { setCurrentUserId, setDevCountry } from "~/lib/session";
import { createAccess } from "../index.server";

let db: TestDb;
let student: typeof schema.users.$inferSelect;
let instructor: typeof schema.users.$inferSelect;
let category: typeof schema.categories.$inferSelect;
let course: typeof schema.courses.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  const base = seedBaseData(db);
  student = base.user;
  instructor = base.instructor;
  category = base.category;
  course = base.course;
});

// ─── Fixtures ───
// Rows go in directly: nothing else writes these tables from a service the
// tests could use. Session cookies are forged through the session module's
// own interface — the same signing the DevUI's switch-user flow uses — so no
// module is mocked.

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

function enroll(userId: number, courseId: number) {
  db.insert(schema.enrollments).values({ userId, courseId }).run();
}

let slugCounter = 0;

// The seeded course is free (price 0), which never PPP-blocks — the matrix
// needs paid courses with an explicit price and pppEnabled.
function addCourse({
  price,
  pppEnabled = true,
}: {
  price: number;
  pppEnabled?: boolean;
}) {
  slugCounter += 1;
  return db
    .insert(schema.courses)
    .values({
      title: `Course ${slugCounter}`,
      slug: `course-${slugCounter}`,
      description: "A course",
      salesCopy: markdown("## A course"),
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price,
      pppEnabled,
    })
    .returning()
    .get();
}

function buy(
  userId: number,
  courseId: number,
  amountPaid: number,
  country: string | null
) {
  return db
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country })
    .returning()
    .get();
}

// ─── Requests ───

function cookieFrom(setCookieHeader: string): string {
  return setCookieHeader.split(";")[0];
}

function applyCookie(request: Request, cookie: string) {
  const headers = new Headers(request.headers);
  headers.set("Cookie", cookie);
  return new Request("http://localhost:3000", { headers });
}

/**
 * A request from `userId` (a signed-out visitor when null) browsing from
 * `country` (the CF-IPCountry header) or with `devCountry` set through the
 * session module's dev override. Every session value is forged through the
 * session module's own interface — the way the DevUI does it — so no module
 * is mocked.
 */
async function requestAs(
  userId: number | null,
  { country, devCountry }: { country?: string; devCountry?: string } = {}
): Promise<Request> {
  const headers: Record<string, string> = {};
  if (country) headers["CF-IPCountry"] = country;

  if (userId !== null || devCountry !== undefined) {
    let scratch = new Request("http://localhost:3000");
    if (userId !== null) {
      scratch = applyCookie(
        scratch,
        cookieFrom(await setCurrentUserId(scratch, userId))
      );
    }
    if (devCountry !== undefined) {
      scratch = applyCookie(
        scratch,
        cookieFrom(await setDevCountry(scratch, devCountry))
      );
    }
    headers.Cookie = scratch.headers.get("Cookie") ?? "";
  }

  return new Request("http://localhost:3000", { headers });
}

// The snapshot a paywall preview renders from: every flag false, nothing
// thrown. The full literal pins the public shape — dead fields included in
// its absence.
const SIGNED_OUT_SNAPSHOT = {
  userId: null,
  isAdmin: false,
  isStaff: false,
  enrolled: false,
  pppBlocked: false,
  pppBlockedCountry: null,
  pppPurchaseCountry: null,
  canViewContent: false,
};

// The guards throw the value `data(message, { status })` builds; a client
// sees `init.status` and `data`, so those are what the tests pin.
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { data: unknown; init: { status?: number } };
  }
  throw new Error("Expected the guard to throw, but it returned");
}

describe("requireUserId", () => {
  it("returns the signed-in user's id", async () => {
    const request = await requestAs(student.id);

    expect(await createAccess(db).requireUserId(request)).toBe(student.id);
  });

  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireUserId(await requestAs(null))
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });
});

describe("getAccess", () => {
  it("describes a signed-out visitor without erroring", async () => {
    const snapshot = await createAccess(db).getAccess(
      await requestAs(null),
      course.id
    );

    expect(snapshot).toEqual(SIGNED_OUT_SNAPSHOT);
  });

  it("treats a session pointing at a missing user as signed out", async () => {
    const request = await requestAs(999_999);

    const snapshot = await createAccess(db).getAccess(request, course.id);

    expect(snapshot).toEqual(SIGNED_OUT_SNAPSHOT);
  });

  it("gives a Platform Admin the course without an enrollment", async () => {
    const admin = addUser("Pat Admin", schema.UserRole.Admin);
    const request = await requestAs(admin.id);

    const snapshot = await createAccess(db).getAccess(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: admin.id,
      isAdmin: true,
      isStaff: true,
      canViewContent: true,
    });
  });

  it("gives the course's own instructor the course without an enrollment", async () => {
    const request = await requestAs(instructor.id);

    const snapshot = await createAccess(db).getAccess(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: instructor.id,
      isStaff: true,
      canViewContent: true,
    });
  });

  it("refuses an instructor who doesn't own the course like a student", async () => {
    const other = addUser("Olive Other", schema.UserRole.Instructor);
    const request = await requestAs(other.id);

    const snapshot = await createAccess(db).getAccess(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: other.id,
    });
  });

  it("lets an enrolled Student read content without a Purchase", async () => {
    enroll(student.id, course.id);
    const request = await requestAs(student.id);

    const snapshot = await createAccess(db).getAccess(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: student.id,
      enrolled: true,
      canViewContent: true,
    });
  });

  it("blocks a discounted Purchase browsed from a different country", async () => {
    const paid = addCourse({ price: 7900 });
    enroll(student.id, paid.id);
    buy(student.id, paid.id, 3900, "IN");
    const request = await requestAs(student.id, { country: "US" });

    const snapshot = await createAccess(db).getAccess(request, paid.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: student.id,
      enrolled: true,
      pppBlocked: true,
      pppBlockedCountry: "US",
      pppPurchaseCountry: "IN",
      canViewContent: false,
    });
  });

  it("lets a discounted Purchase browse from the country it was bought in", async () => {
    const paid = addCourse({ price: 7900 });
    enroll(student.id, paid.id);
    buy(student.id, paid.id, 3900, "IN");
    const request = await requestAs(student.id, { devCountry: "IN" });

    const snapshot = await createAccess(db).getAccess(request, paid.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: student.id,
      enrolled: true,
      canViewContent: true,
    });
  });

  it("never blocks a course with country pricing disabled", async () => {
    const unrestricted = addCourse({ price: 7900, pppEnabled: false });
    enroll(student.id, unrestricted.id);
    buy(student.id, unrestricted.id, 3900, "IN");
    const request = await requestAs(student.id, { country: "US" });

    const snapshot = await createAccess(db).getAccess(
      request,
      unrestricted.id
    );

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: student.id,
      enrolled: true,
      canViewContent: true,
    });
  });

  it("never blocks a free course, whatever the browsing country", async () => {
    enroll(student.id, course.id);
    buy(student.id, course.id, 0, "IN");
    const request = await requestAs(student.id, { country: "US" });

    const snapshot = await createAccess(db).getAccess(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: student.id,
      enrolled: true,
      canViewContent: true,
    });
  });

  it("exempts staff from country blocks", async () => {
    const paid = addCourse({ price: 7900 });
    enroll(instructor.id, paid.id);
    buy(instructor.id, paid.id, 3900, "IN");
    const request = await requestAs(instructor.id, { country: "US" });

    const snapshot = await createAccess(db).getAccess(request, paid.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: instructor.id,
      isStaff: true,
      enrolled: true,
      canViewContent: true,
    });
  });
});

describe("requireContentAccess", () => {
  it("returns the snapshot for someone who may read the course", async () => {
    enroll(student.id, course.id);
    const request = await requestAs(student.id);

    const snapshot = await createAccess(db).requireContentAccess(
      request,
      course.id
    );

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: student.id,
      enrolled: true,
      canViewContent: true,
    });
  });

  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireContentAccess(await requestAs(null), course.id)
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });

  it("throws 403 for a signed-in visitor without an enrollment", async () => {
    const request = await requestAs(student.id);

    const error = await rejection(
      createAccess(db).requireContentAccess(request, course.id)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("You must be enrolled in this course.");
  });

  it("throws the same 403 for a country-blocked Student", async () => {
    const paid = addCourse({ price: 7900 });
    enroll(student.id, paid.id);
    buy(student.id, paid.id, 3900, "IN");
    const request = await requestAs(student.id, { country: "US" });

    const error = await rejection(
      createAccess(db).requireContentAccess(request, paid.id)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("You must be enrolled in this course.");
  });
});

describe("requireStaff", () => {
  it("returns the snapshot for the course's own instructor", async () => {
    const request = await requestAs(instructor.id);

    const snapshot = await createAccess(db).requireStaff(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: instructor.id,
      isStaff: true,
      canViewContent: true,
    });
  });

  it("returns the snapshot for a Platform Admin", async () => {
    const admin = addUser("Pat Admin", schema.UserRole.Admin);
    const request = await requestAs(admin.id);

    const snapshot = await createAccess(db).requireStaff(request, course.id);

    expect(snapshot).toEqual({
      ...SIGNED_OUT_SNAPSHOT,
      userId: admin.id,
      isAdmin: true,
      isStaff: true,
      canViewContent: true,
    });
  });

  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireStaff(await requestAs(null), course.id)
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });

  it("throws 403 for an instructor who doesn't own the course", async () => {
    const other = addUser("Olive Other", schema.UserRole.Instructor);
    const request = await requestAs(other.id);

    const error = await rejection(
      createAccess(db).requireStaff(request, course.id)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only this course's instructor can do that.");
  });

  it("throws 403 for a Student", async () => {
    const request = await requestAs(student.id);

    const error = await rejection(
      createAccess(db).requireStaff(request, course.id)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only this course's instructor can do that.");
  });
});

describe("requireInstructorOrAdmin", () => {
  it("returns the viewer for an Instructor", async () => {
    const request = await requestAs(instructor.id);

    const viewer = await createAccess(db).requireInstructorOrAdmin(request);

    expect(viewer).toEqual({ userId: instructor.id, isAdmin: false });
  });

  it("returns the viewer for a Platform Admin, flagging the role", async () => {
    const admin = addUser("Pat Admin", schema.UserRole.Admin);
    const request = await requestAs(admin.id);

    const viewer = await createAccess(db).requireInstructorOrAdmin(request);

    expect(viewer).toEqual({ userId: admin.id, isAdmin: true });
  });

  it("throws 401 for a signed-out visitor", async () => {
    const error = await rejection(
      createAccess(db).requireInstructorOrAdmin(await requestAs(null))
    );

    expect(error.init.status).toBe(401);
    expect(error.data).toBe("Select a user from the DevUI panel.");
  });

  it("throws 403 for a Student", async () => {
    const request = await requestAs(student.id);

    const error = await rejection(
      createAccess(db).requireInstructorOrAdmin(request)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only instructors can access this page.");
  });

  it("throws 403, not 401, for a session pointing at a missing user", async () => {
    const request = await requestAs(999_999);

    const error = await rejection(
      createAccess(db).requireInstructorOrAdmin(request)
    );

    expect(error.init.status).toBe(403);
    expect(error.data).toBe("Only instructors can access this page.");
  });
});
