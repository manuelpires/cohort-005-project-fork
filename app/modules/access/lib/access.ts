import { data } from "react-router";
import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { UserRole, users, courses, enrollments, purchases } from "~/db/schema";
import { getCurrentUserId } from "~/lib/session";
import { resolveCountry } from "~/lib/country.server";
import { checkPppAccess } from "~/lib/ppp";

export type Db = BetterSQLite3Database<typeof schema>;

/** The person asking: a signed-in user, plus whether they're a Platform Admin. */
export type Viewer = { userId: number; isAdmin: boolean };

/**
 * What a person may currently do with a course — read its content, moderate
 * it, or nothing — given who they are, whether they hold an Enrollment, and
 * where they're browsing from. The require* guards return this after throwing
 * for anyone who doesn't measure up, so `userId` is always set there.
 */
export type Access = Viewer & {
  /** Owning instructor or Platform Admin — the people who speak for the course. */
  isStaff: boolean;
  enrolled: boolean;
  pppBlocked: boolean;
  pppBlockedCountry: string | null;
  pppPurchaseCountry: string | null;
  /**
   * May they read the course's content (lesson bodies, comments)?
   * Staff always can. Students need an enrollment that isn't PPP-blocked.
   */
  canViewContent: boolean;
};

/**
 * The snapshot for a signed-out visitor (or a session pointing at a missing
 * user): describes them without erroring, so the lesson page can render a
 * paywall preview instead of failing.
 */
export type SignedOutAccess = Omit<Access, "userId"> & { userId: null };

const SIGNED_OUT: SignedOutAccess = {
  userId: null,
  isAdmin: false,
  isStaff: false,
  enrolled: false,
  pppBlocked: false,
  pppBlockedCountry: null,
  pppPurchaseCountry: null,
  canViewContent: false,
};

function getUserById(database: Db, id: number) {
  return database.select().from(users).where(eq(users.id, id)).get();
}

function getCourseById(database: Db, id: number) {
  return database.select().from(courses).where(eq(courses.id, id)).get();
}

function isUserEnrolled(database: Db, userId: number, courseId: number) {
  return (
    database
      .select()
      .from(enrollments)
      .where(
        and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
      )
      .get() !== undefined
  );
}

function findPurchase(database: Db, userId: number, courseId: number) {
  // KNOWN AMBIGUITY, preserved deliberately: a user can hold more than one
  // Purchase for the same course — a Team Admin also holds their own
  // purchases row for the Team Licence they bought — and `.get()` with no
  // ORDER BY picks one arbitrarily, so the PPP check may read the wrong
  // Purchase's country. An Enrollment does not record its granting Purchase
  // and the purchases table cannot tell an Individual Purchase from a Team
  // Licence, so fixing this needs a schema change (tracked as a follow-up).
  return database
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .get();
}

/**
 * getAccess never throws — the lesson page needs to render a paywall preview
 * for signed-out and unenrolled visitors rather than erroring. The require*
 * wrappers are built on it for the routes that should just reject.
 */
export async function getAccess(
  database: Db,
  request: Request,
  courseId: number
): Promise<Access | SignedOutAccess> {
  const userId = await getCurrentUserId(request);
  if (!userId) return SIGNED_OUT;

  const user = getUserById(database, userId);
  if (!user) return SIGNED_OUT;

  const course = getCourseById(database, courseId);
  const isAdmin = user.role === UserRole.Admin;
  // Owning the course is an instructor's only staff privilege on it — the
  // check feeds the staff flag and stays inside.
  const isOwningInstructor = course?.instructorId === userId;
  const isStaff = isAdmin || isOwningInstructor;
  const enrolled = isUserEnrolled(database, userId, courseId);

  // PPP only restricts students who bought at a discount — staff are exempt.
  let ppp = {
    blocked: false,
    blockedCountry: null as string | null,
    purchaseCountry: null as string | null,
  };

  if (enrolled && !isStaff && course) {
    const purchase = findPurchase(database, userId, courseId);
    const currentCountry = await resolveCountry(request);
    ppp = checkPppAccess(
      course.price,
      course.pppEnabled,
      purchase?.country ?? null,
      currentCountry
    );
  }

  return {
    userId,
    isAdmin,
    isStaff,
    enrolled,
    pppBlocked: ppp.blocked,
    pppBlockedCountry: ppp.blockedCountry,
    pppPurchaseCountry: ppp.purchaseCountry,
    canViewContent: isStaff || (enrolled && !ppp.blocked),
  };
}

/**
 * Throws 401 unless someone is signed in. Returns their user id.
 */
export async function requireUserId(request: Request): Promise<number> {
  const userId = await getCurrentUserId(request);
  if (!userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }
  return userId;
}

/**
 * Throws 401 when signed out, 403 when the user can't see the course's
 * content. Use in actions — loader guards don't protect actions.
 */
export async function requireContentAccess(
  database: Db,
  request: Request,
  courseId: number
): Promise<Access> {
  const access = await getAccess(database, request, courseId);

  if (!access.userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  if (!access.canViewContent) {
    throw data("You must be enrolled in this course.", { status: 403 });
  }

  return access;
}

/**
 * Throws unless the user is the course's own instructor, or an admin.
 */
export async function requireStaff(
  database: Db,
  request: Request,
  courseId: number
): Promise<Access> {
  const access = await getAccess(database, request, courseId);

  if (!access.userId) {
    throw data("Select a user from the DevUI panel.", { status: 401 });
  }

  if (!access.isStaff) {
    throw data("Only this course's instructor can do that.", { status: 403 });
  }

  return access;
}

/**
 * Throws unless the user is an instructor or an admin, without tying them to
 * a particular course — for pages that span all of someone's courses.
 */
export async function requireInstructorOrAdmin(
  database: Db,
  request: Request
): Promise<Viewer> {
  const userId = await requireUserId(request);
  const user = getUserById(database, userId);

  if (
    !user ||
    (user.role !== UserRole.Instructor && user.role !== UserRole.Admin)
  ) {
    throw data("Only instructors can access this page.", { status: 403 });
  }

  return { userId, isAdmin: user.role === UserRole.Admin };
}
