import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { coupons, enrollments, purchases } from "~/db/schema";
import { getSeatAvailability } from "~/lib/refunds.server";
import {
  defaultNotificationsPort,
  type NotificationsPort,
} from "./notifications.server";
import {
  notifyEnrollmentCreated,
  notifySeatClaimed,
} from "./enrollment-notifications.server";

// ─── Seats ───
// Claiming a Seat on a Team Licence: the claimer spends the Seat's code and
// gets an Enrollment on the licence's course. See GLOSSARY.md.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Uses positional parameters (project convention).

type Db = BetterSQLite3Database<typeof schema>;

export const SEAT_ON_HOLD =
  "This seat can't be claimed right now. Ask the person who shared it with you.";
export const SEAT_REFUNDED =
  "This seat is no longer available. Ask the person who shared it with you.";

export function getCouponByCode(db: Db, code: string) {
  return db.select().from(coupons).where(eq(coupons.code, code)).get();
}

export type RedeemSeatResult =
  | { ok: true; enrollment: typeof enrollments.$inferSelect }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

/**
 * Claims a Seat with its code. The Seat must be unclaimed and available (a
 * Team Licence's Unclaimed Seats are on hold while it has an Open Refund
 * Request, and lost once it is approved), the claimer must not already hold
 * an Enrollment on the course, and the claim must come from the purchaser's
 * country. After the write commits, the licence's Team Admin is notified
 * about the claim and the course's Instructor about the new Enrollment (both
 * best-effort; the Instructor's stays suppressed until they opt in).
 */
export async function redeemSeat(
  db: Db,
  code: string,
  userId: number,
  userCountry: string,
  now: Date,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<RedeemSeatResult> {
  const coupon = getCouponByCode(db, code);
  if (!coupon) {
    return { ok: false, status: 404, error: "Coupon not found" };
  }

  if (coupon.redeemedByUserId !== null) {
    return {
      ok: false,
      status: 409,
      error: "Coupon has already been redeemed",
    };
  }

  const availability = getSeatAvailability(db, coupon);
  if (availability === "on_hold") {
    return { ok: false, status: 409, error: SEAT_ON_HOLD };
  }
  if (availability === "refunded") {
    return { ok: false, status: 409, error: SEAT_REFUNDED };
  }

  const existingEnrollment = db
    .select()
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.courseId, coupon.courseId)
      )
    )
    .get();

  if (existingEnrollment) {
    return {
      ok: false,
      status: 409,
      error: "You are already enrolled in this course",
    };
  }

  const purchase = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, coupon.purchaseId))
    .get();

  if (purchase?.country && purchase.country !== userCountry) {
    return {
      ok: false,
      status: 403,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    };
  }

  db.update(coupons)
    .set({
      redeemedByUserId: userId,
      redeemedAt: now.toISOString(),
    })
    .where(eq(coupons.id, coupon.id))
    .run();

  const enrollment = db
    .insert(enrollments)
    .values({
      userId,
      courseId: coupon.courseId,
      enrolledAt: now.toISOString(),
    })
    .returning()
    .get();

  await notifySeatClaimed(db, coupon.id, port);
  await notifyEnrollmentCreated(db, enrollment.id, port);

  return { ok: true, enrollment };
}
