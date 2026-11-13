import { and, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { courses, coupons, enrollments, purchases, users } from "~/db/schema";
import type { NotificationsPort } from "./notifications.server";

// ─── Enrollment and Seat-claim Notifications ───
// The growth half of the Notification catalogue: a new Enrollment (Individual
// Purchase or Claimed Seat, including a Lapsed Student enrolling again) tells
// the course's Instructor who joined; a claimed Seat tells the Team Admin who
// owns the Team Licence who claimed it and how many Seats are left. Buying a
// Team Licence alone grants no Enrollment, so it notifies nobody. See
// GLOSSARY.md and PRD #53's catalogue rows 4 and 5.
//
// Recipients and content are resolved here from the database; the vendor
// evaluates each recipient's Enrollments preference at delivery time, so the
// Instructor's Notification stays suppressed until they opt in (row 5 is off
// by default). Nobody is notified about their own action.

type Db = BetterSQLite3Database<typeof schema>;

async function fireNotification(
  port: NotificationsPort,
  fire: () => Promise<void>
): Promise<void> {
  // Best-effort: a failed trigger is caught and logged, never failing the
  // domain action around it.
  try {
    await fire();
  } catch (error) {
    console.error("Notification trigger failed:", error);
  }
}

/**
 * Tells the course's Instructor that a Student enrolled — which Student, on
 * which course. Fired after the Enrollment write commits.
 */
export async function notifyEnrollmentCreated(
  db: Db,
  enrollmentId: number,
  port: NotificationsPort
): Promise<void> {
  await fireNotification(port, async () => {
    const enrollment = db
      .select()
      .from(enrollments)
      .where(eq(enrollments.id, enrollmentId))
      .get();
    if (!enrollment) return;

    const student = db
      .select()
      .from(users)
      .where(eq(users.id, enrollment.userId))
      .get();
    const course = db
      .select()
      .from(courses)
      .where(eq(courses.id, enrollment.courseId))
      .get();
    if (!student || !course) return;

    const instructor = db
      .select()
      .from(users)
      .where(eq(users.id, course.instructorId))
      .get();
    if (!instructor) return;

    // A person is never notified about their own action.
    if (instructor.id === student.id) return;

    await port.trigger({
      workflow: "enrollment-created",
      recipients: [instructor.id],
      actor: student.id,
      data: {
        studentName: student.name,
        courseTitle: course.title,
        url: `/instructor/${course.id}/students`,
      },
      idempotencyKey: `enrollment-created:${enrollment.id}`,
    });
  });
}

/**
 * Tells the Team Admin who owns a Team Licence that one of its Seats was
 * claimed — who claimed it, on which course, and how many Seats remain. One
 * notification per claim. Fired after the claim write commits.
 */
export async function notifySeatClaimed(
  db: Db,
  couponId: number,
  port: NotificationsPort
): Promise<void> {
  await fireNotification(port, async () => {
    const coupon = db
      .select()
      .from(coupons)
      .where(eq(coupons.id, couponId))
      .get();
    if (!coupon || coupon.redeemedByUserId === null) return;

    const claimer = db
      .select()
      .from(users)
      .where(eq(users.id, coupon.redeemedByUserId))
      .get();
    const course = db
      .select()
      .from(courses)
      .where(eq(courses.id, coupon.courseId))
      .get();
    // The owner of a Team Licence is the buyer of the Purchase that granted
    // its Seats.
    const licence = db
      .select()
      .from(purchases)
      .where(eq(purchases.id, coupon.purchaseId))
      .get();
    if (!claimer || !course || !licence) return;

    // A person is never notified about their own action.
    if (licence.userId === claimer.id) return;

    const seatsLeft = db
      .select()
      .from(coupons)
      .where(
        and(
          eq(coupons.purchaseId, coupon.purchaseId),
          isNull(coupons.redeemedAt)
        )
      )
      .all().length;

    await port.trigger({
      workflow: "seat-claimed",
      recipients: [licence.userId],
      actor: claimer.id,
      data: {
        claimerName: claimer.name,
        courseTitle: course.title,
        seatsLeft,
        url: "/team",
      },
      idempotencyKey: `seat-claimed:${coupon.id}`,
    });
  });
}
