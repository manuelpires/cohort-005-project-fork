import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { markdown } from "~/lib/text";
import { setCurrentUserId } from "~/lib/session";
import {
  loader,
  action,
} from "~/routes/courses.$slug.lessons.$lessonId";

// The lesson route reads the app database (`~/db`), which opens `data.db`
// relative to the process cwd — so these tests run the whole process out of
// a temp directory seeded with a migrated file db. The route's loader and
// action are the seam: requests are forged through the session module's own
// cookie signing (exactly what the DevUI's switch-user flow does) and the
// country comes in on the CF-IPCountry header, like production traffic.
const workDir = mkdtempSync(path.join(tmpdir(), "lesson-route-"));
const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url)
);

let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(() => {
  process.chdir(workDir);
  const sqlite = new Database(path.join(workDir, "data.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
});

// ─── Fixtures ───
// Rows go in directly, mirroring the module tests. Personas are distinct
// users so the loader's writes (lesson progress) can't cross tests.

function addUser(name: string, role = UserRole.Student) {
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

let student: ReturnType<typeof addUser>;
let pppStudent: ReturnType<typeof addUser>;
let outsider: ReturnType<typeof addUser>;
let instructor: ReturnType<typeof addUser>;
let admin: ReturnType<typeof addUser>;
let course: typeof schema.courses.$inferSelect;
let lesson: typeof schema.lessons.$inferSelect;

beforeAll(() => {
  student = addUser("Route Student");
  pppStudent = addUser("Route Ppp Student");
  outsider = addUser("Route Outsider");
  instructor = addUser("Route Instructor", UserRole.Instructor);
  admin = addUser("Route Admin", UserRole.Admin);

  const category = db
    .insert(schema.categories)
    .values({ name: "Route Category", slug: "route-category" })
    .returning()
    .get();

  // Paid + PPP-enabled so the country matrix can bite; the owning instructor
  // is the staff persona.
  course = db
    .insert(schema.courses)
    .values({
      title: "Route Course",
      slug: "route-course",
      description: "A course",
      salesCopy: markdown("## A course"),
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
      price: 7900,
      pppEnabled: true,
    })
    .returning()
    .get();

  const mod = db
    .insert(schema.modules)
    .values({ courseId: course.id, title: "M1", position: 1 })
    .returning()
    .get();

  lesson = db
    .insert(schema.lessons)
    .values({
      moduleId: mod.id,
      title: "Route Lesson",
      position: 1,
      content: markdown("## Route lesson\n\nThe lesson body."),
    })
    .returning()
    .get();

  const enroll = (userId: number) =>
    db.insert(schema.enrollments).values({ userId, courseId: course.id }).run();
  enroll(student.id);
  enroll(pppStudent.id);

  // A discounted Purchase from India: browsing from anywhere else blocks.
  db.insert(schema.purchases)
    .values({
      userId: pppStudent.id,
      courseId: course.id,
      amountPaid: 2500,
      country: "IN",
    })
    .run();

  // A discussion the content personas can see and the paywalled ones can't.
  db.insert(schema.comments)
    .values({
      lessonId: lesson.id,
      userId: student.id,
      body: markdown("Seeded question about the lesson"),
    })
    .run();
});

// ─── Request forging ───

function cookieFrom(setCookieHeader: string) {
  return setCookieHeader.split(";")[0];
}

function lessonUrl() {
  return `http://localhost:3000/courses/${course.slug}/lessons/${lesson.id}`;
}

async function getAs(userId: number | null, country?: string) {
  const headers: Record<string, string> = {};
  if (userId != null) {
    const setCookie = await setCurrentUserId(
      new Request("http://localhost:3000"),
      userId
    );
    headers.Cookie = cookieFrom(setCookie);
  }
  if (country) headers["CF-IPCountry"] = country;
  return new Request(lessonUrl(), { headers });
}

async function postAs(
  userId: number | null,
  fields: Record<string, string>,
  country?: string
) {
  const headers: Record<string, string> = {};
  if (userId != null) {
    const setCookie = await setCurrentUserId(
      new Request("http://localhost:3000"),
      userId
    );
    headers.Cookie = cookieFrom(setCookie);
  }
  if (country) headers["CF-IPCountry"] = country;
  return new Request(lessonUrl(), {
    method: "POST",
    body: new URLSearchParams(fields),
    headers,
  });
}

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

// The guards throw the value `data(message, { status })` builds; a client
// sees `init.status` and `data`, so those are what the tests pin.
async function thrownFrom(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { data: unknown; init: { status?: number } };
  }
  throw new Error("expected the route to throw");
}

function loaderArgs(request: Request): LoaderArgs {
  return {
    params: { slug: course.slug, lessonId: String(lesson.id) },
    request,
  } as LoaderArgs;
}

function actionArgs(request: Request): ActionArgs {
  return {
    params: { slug: course.slug, lessonId: String(lesson.id) },
    request,
  } as ActionArgs;
}

// ─── Loader: what each persona gets ───

describe("lesson loader", () => {
  it("renders the paywall preview for a signed-out visitor instead of erroring", async () => {
    const result = await loader(loaderArgs(await getAs(null)));

    expect(result.currentUserId).toBeNull();
    expect(result.enrolled).toBe(false);
    expect(result.canViewContent).toBe(false);
    expect(result.canModerate).toBe(false);
    expect(result.pppBlocked).toBe(false);
    expect(result.comments).toEqual([]);
  });

  it("renders the paywall preview for a signed-in unenrolled student", async () => {
    const result = await loader(loaderArgs(await getAs(outsider.id)));

    expect(result.currentUserId).toBe(outsider.id);
    expect(result.enrolled).toBe(false);
    expect(result.canViewContent).toBe(false);
    expect(result.canModerate).toBe(false);
    expect(result.comments).toEqual([]);
  });

  it("serves content and the discussion to an enrolled student", async () => {
    const result = await loader(loaderArgs(await getAs(student.id)));

    expect(result.currentUserId).toBe(student.id);
    expect(result.enrolled).toBe(true);
    expect(result.canViewContent).toBe(true);
    expect(result.canModerate).toBe(false);
    expect(result.pppBlocked).toBe(false);
    expect(
      result.comments.some((c) => c.author.name === "Route Student")
    ).toBe(true);
  });

  it("renders the country paywall to a student browsing outside their purchase country", async () => {
    const result = await loader(loaderArgs(await getAs(pppStudent.id, "US")));

    expect(result.currentUserId).toBe(pppStudent.id);
    expect(result.enrolled).toBe(true);
    expect(result.pppBlocked).toBe(true);
    expect(result.pppBlockedCountry).toBe("US");
    expect(result.pppPurchaseCountry).toBe("IN");
    expect(result.canViewContent).toBe(false);
    expect(result.comments).toEqual([]);
  });

  it("serves content when the discounted student browses from their purchase country", async () => {
    const result = await loader(loaderArgs(await getAs(pppStudent.id, "IN")));

    expect(result.pppBlocked).toBe(false);
    expect(result.canViewContent).toBe(true);
  });

  it("serves content plus the moderation flag to the owning instructor", async () => {
    const result = await loader(loaderArgs(await getAs(instructor.id)));

    expect(result.currentUserId).toBe(instructor.id);
    expect(result.enrolled).toBe(false);
    expect(result.canViewContent).toBe(true);
    expect(result.canModerate).toBe(true);
  });

  it("serves content plus the moderation flag to a Platform Admin", async () => {
    const result = await loader(loaderArgs(await getAs(admin.id)));

    expect(result.currentUserId).toBe(admin.id);
    expect(result.canViewContent).toBe(true);
    expect(result.canModerate).toBe(true);
  });
});

// ─── Action: comment and bookmark intents through the content-access guard ───

describe("lesson action", () => {
  it("rejects a comment from a signed-out visitor with the route's own sign-in error", async () => {
    const request = await postAs(null, {
      intent: "create-comment",
      body: "Drive-by comment",
    });

    const error = await thrownFrom(action(actionArgs(request)));
    expect(error.init.status).toBe(401);
    expect(error.data).toBe("You must be logged in");
  });

  it("rejects a comment from an unenrolled student through the content-access guard", async () => {
    const request = await postAs(outsider.id, {
      intent: "create-comment",
      body: "Let me in",
    });

    const error = await thrownFrom(action(actionArgs(request)));
    expect(error.init.status).toBe(403);
    expect(error.data).toBe("You must be enrolled in this course.");
  });

  it("accepts a comment from an enrolled student and shows it on reload", async () => {
    const request = await postAs(student.id, {
      intent: "create-comment",
      body: "Posted through the route",
    });

    await expect(action(actionArgs(request))).resolves.toEqual({ ok: true });

    const result = await loader(loaderArgs(await getAs(student.id)));
    expect(
      result.comments.some((c) => c.body === "Posted through the route")
    ).toBe(true);
  });

  it("lets the owning instructor delete a student's comment via the moderation flag", async () => {
    const seeded = db
      .select()
      .from(schema.comments)
      .all()
      .find((c) => c.body === "Seeded question about the lesson");
    expect(seeded).toBeDefined();

    const request = await postAs(instructor.id, {
      intent: "delete-comment",
      commentId: String(seeded!.id),
    });

    await expect(action(actionArgs(request))).resolves.toEqual({ ok: true });

    const result = await loader(loaderArgs(await getAs(student.id)));
    expect(
      result.comments.some((c) => c.body === "Seeded question about the lesson")
    ).toBe(false);
  });

  it("guards bookmark and note intents with the content-access guard too", async () => {
    const refused = await thrownFrom(
      action(
        actionArgs(await postAs(outsider.id, { intent: "toggle-bookmark" }))
      )
    );
    expect(refused.init.status).toBe(403);
    expect(refused.data).toBe("You must be enrolled in this course.");

    await expect(
      action(
        actionArgs(await postAs(student.id, { intent: "toggle-bookmark" }))
      )
    ).resolves.toEqual({ ok: true, bookmarked: true });
  });
});
