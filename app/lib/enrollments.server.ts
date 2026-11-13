import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  courses,
  coupons,
  enrollments,
  purchases,
  teamMembers,
  teams,
  TeamMemberRole,
} from "~/db/schema";
import {
  defaultNotificationsPort,
  type NotificationsPort,
} from "./notifications.server";
import { notifyEnrollmentCreated } from "./enrollment-notifications.server";

// ─── Enrollments ───
// How a Student gets their place on a course: buying an Individual Purchase
// (enrolls the buyer) or buying a Team Licence (grants Seats, enrolls nobody —
// each Seat is claimed separately through seats.server). See GLOSSARY.md.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Db = BetterSQLite3Database<typeof schema>;

export function isUserEnrolled(db: Db, userId: number, courseId: number) {
  return !!findEnrollment(db, userId, courseId);
}

function findEnrollment(db: Db, userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export type EnrollOnPurchaseResult =
  | {
      ok: true;
      purchase: typeof purchases.$inferSelect;
      enrollment: typeof enrollments.$inferSelect;
    }
  | { ok: false; status: 404 | 409; error: string };

/**
 * An Individual Purchase: records the payment and gives the buyer their
 * Enrollment. A Student has at most one Enrollment per course. After the
 * write commits, the course's Instructor is notified about the new Enrollment
 * (best-effort, suppressed while their Enrollments preference is off).
 */
export async function enrollOnPurchase(
  db: Db,
  userId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  now: Date,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<EnrollOnPurchaseResult> {
  if (findEnrollment(db, userId, courseId)) {
    return {
      ok: false,
      status: 409,
      error: "User is already enrolled in this course",
    };
  }

  const course = db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) {
    return { ok: false, status: 404, error: "Course not found" };
  }

  const purchase = db
    .insert(purchases)
    .values({
      userId,
      courseId,
      amountPaid,
      country,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId, enrolledAt: now.toISOString() })
    .returning()
    .get();

  await notifyEnrollmentCreated(db, enrollment.id, port);

  return { ok: true, purchase, enrollment };
}

export type PurchaseTeamLicenceResult =
  | {
      ok: true;
      purchase: typeof purchases.$inferSelect;
      team: typeof teams.$inferSelect;
      coupons: (typeof coupons.$inferSelect)[];
    }
  | { ok: false; status: 404; error: string };

/**
 * A Team Licence: one payment that grants Seats, not an Enrollment — the
 * buyer can't take the course through it. The buyer becomes the Team Admin
 * of the licence's team. Buying the licence alone notifies nobody; each Seat
 * claim does, through seats.server.
 */
export async function purchaseTeamLicence(
  db: Db,
  userId: number,
  courseId: number,
  amountPaid: number,
  country: string | null,
  quantity: number,
  now: Date,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<PurchaseTeamLicenceResult> {
  const course = db
    .select()
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();
  if (!course) {
    return { ok: false, status: 404, error: "Course not found" };
  }

  const purchase = db
    .insert(purchases)
    .values({
      userId,
      courseId,
      amountPaid,
      country,
      createdAt: now.toISOString(),
    })
    .returning()
    .get();

  const team = getOrCreateTeamForAdmin(db, userId);
  const coupons = generateCoupons(db, team.id, courseId, purchase.id, quantity);

  return { ok: true, purchase, team, coupons };
}

function getOrCreateTeamForAdmin(db: Db, userId: number) {
  const membership = db
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.userId, userId),
        eq(teamMembers.role, TeamMemberRole.Admin)
      )
    )
    .get();

  if (membership) {
    const existing = db
      .select()
      .from(teams)
      .where(eq(teams.id, membership.teamId))
      .get();
    if (existing) return existing;
  }

  const team = db.insert(teams).values({}).returning().get();
  db.insert(teamMembers)
    .values({ teamId: team.id, userId, role: TeamMemberRole.Admin })
    .returning()
    .get();
  return team;
}

function generateCoupons(
  db: Db,
  teamId: number,
  courseId: number,
  purchaseId: number,
  quantity: number
) {
  const created: (typeof coupons.$inferSelect)[] = [];
  for (let i = 0; i < quantity; i++) {
    const coupon = db
      .insert(coupons)
      .values({
        teamId,
        courseId,
        code: crypto.randomBytes(12).toString("base64url"),
        purchaseId,
      })
      .returning()
      .get();
    created.push(coupon);
  }
  return created;
}
