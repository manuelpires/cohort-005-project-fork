import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { raiseRefundRequest } from "./refunds.server";
import type { FakeNotifications } from "./notifications.fake.server";
import type { seedBaseData, TestDb } from "~/test/setup";

/** The instant every Refund test is pinned to: October 6th 2026, noon. */
export const NOW = new Date(2026, 9, 6, 12, 0, 0);

export type RefundFixture = ReturnType<typeof seedRefundFixture>;

function seedPlatformAdmin(db: TestDb) {
  return db
    .insert(schema.users)
    .values({
      name: "Pat Admin",
      email: "pat@example.com",
      role: UserRole.Admin,
    })
    .returning()
    .get();
}

function seedBasicsLessons(db: TestDb, courseId: number) {
  const module = db
    .insert(schema.modules)
    .values({ courseId, title: "Basics", position: 1 })
    .returning()
    .get();

  return [1, 2, 3, 4].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
}

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

function addStudent(db: TestDb, name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function buyForSelf(
  db: TestDb,
  courseId: number,
  userId: number,
  daysAgo = 3,
  amountPaid = 7900
) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId,
      amountPaid,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  db.insert(schema.enrollments).values({ userId, courseId }).run();
  return purchase;
}

function buySeats(
  db: TestDb,
  courseId: number,
  userId: number,
  seats: number,
  daysAgo = 3
) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId,
      amountPaid: 7900 * seats,
      createdAt: daysBefore(daysAgo),
    })
    .returning()
    .get();
  const seatRows = Array.from({ length: seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
  return { purchase, seats: seatRows };
}

function claimSeat(
  db: TestDb,
  courseId: number,
  seatId: number,
  userId: number
) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: daysBefore(1) })
    .where(eq(schema.coupons.id, seatId))
    .run();
  db.insert(schema.enrollments).values({ userId, courseId }).run();
}

/**
 * The cast both Refund suites share, bound to one test db: Pat Admin, the
 * Basics module, four lessons, and the purchase / seat / claim / request
 * helpers every scenario starts from.
 */
export function seedRefundFixture(
  db: TestDb,
  base: ReturnType<typeof seedBaseData>,
  notifications: FakeNotifications
) {
  return {
    platformAdmin: seedPlatformAdmin(db),
    lessonIds: seedBasicsLessons(db, base.course.id),
    daysBefore,
    addStudent: (name: string) => addStudent(db, name),
    buyForSelf: (userId: number, daysAgo?: number, amountPaid?: number) =>
      buyForSelf(db, base.course.id, userId, daysAgo, amountPaid),
    buySeats: (userId: number, seats: number, daysAgo?: number) =>
      buySeats(db, base.course.id, userId, seats, daysAgo),
    claimSeat: (seatId: number, userId: number) =>
      claimSeat(db, base.course.id, seatId, userId),
    raise: async (purchaseId: number, buyerId: number) => {
      const result = await raiseRefundRequest(
        db,
        purchaseId,
        buyerId,
        "It was not what I expected.",
        NOW,
        notifications
      );
      if (!result.ok) throw new Error(result.error);
      return result.refundRequestId;
    },
  };
}
