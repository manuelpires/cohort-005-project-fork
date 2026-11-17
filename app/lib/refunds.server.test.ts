import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { LessonProgressStatus, RefundStatus } from "~/db/schema";
import {
  approveRefundRequest,
  checkRefundRequest,
  declineRefundRequest,
  getNewestIndividualPurchase,
  getRefundOffer,
  getSeatAvailability,
  raiseRefundRequest,
} from "./refunds.server";
import { isBookmarked, toggleBookmark } from "./bookmarks.server";
import { getNote, saveNote } from "~/modules/notes/index.server";
import {
  fakeNotifications,
  type FakeNotifications,
} from "./notifications.fake.server";
import {
  NOW,
  seedRefundFixture,
  type RefundFixture,
} from "./refunds.fixtures.server";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let fx: RefundFixture;
let notifications: FakeNotifications;

beforeEach(() => {
  db = createTestDb();
  notifications = fakeNotifications();
  base = seedBaseData(db);
  fx = seedRefundFixture(db, base, notifications);
});

function isEnrolled(userId: number) {
  return !!db
    .select()
    .from(schema.enrollments)
    .where(
      and(
        eq(schema.enrollments.userId, userId),
        eq(schema.enrollments.courseId, base.course.id)
      )
    )
    .get();
}

function getSeat(seatId: number) {
  const seat = db
    .select()
    .from(schema.coupons)
    .where(eq(schema.coupons.id, seatId))
    .get();
  if (!seat) throw new Error("Seat not found");
  return seat;
}

describe("raising a Refund Request", () => {
  it("lets the buyer raise one on an Individual Purchase inside the window", async () => {
    const purchase = fx.buyForSelf(base.user.id);

    const result = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Nope.",
      NOW,
      notifications
    );

    expect(result).toMatchObject({ ok: true, kind: "individual_purchase" });
  });

  it("throws when the fixture is asked to raise on a purchase that does not exist", async () => {
    await expect(fx.raise(999999, base.user.id)).rejects.toThrow();
  });

  it("refuses anyone but the buyer", () => {
    const purchase = fx.buyForSelf(base.user.id);
    const someoneElse = fx.addStudent("Ben");

    expect(
      checkRefundRequest(db, purchase.id, someoneElse.id, NOW)
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("allows only one Open Refund Request per Purchase", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    await fx.raise(purchase.id, base.user.id);

    expect(
      checkRefundRequest(db, purchase.id, base.user.id, NOW)
    ).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps the fourteenth day open and closes the fifteenth", () => {
    const onDay14 = fx.buyForSelf(base.user.id, 14);
    const onDay15 = fx.buyForSelf(fx.addStudent("Ben").id, 15);

    expect(checkRefundRequest(db, onDay14.id, onDay14.userId, NOW).ok).toBe(
      true
    );
    expect(
      checkRefundRequest(db, onDay15.id, onDay15.userId, NOW)
    ).toMatchObject({ ok: false, error: "The 14-day window has closed." });
  });

  it("refuses a buyer who has completed half the lessons", () => {
    const purchase = fx.buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values(
        fx.lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    expect(
      checkRefundRequest(db, purchase.id, base.user.id, NOW)
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a buyer who has watched two hours", () => {
    const purchase = fx.buyForSelf(base.user.id);
    db.insert(schema.videoWatchEvents)
      .values([
        {
          userId: base.user.id,
          lessonId: fx.lessonIds[0],
          eventType: "progress",
          positionSeconds: 3600,
        },
        {
          userId: base.user.id,
          lessonId: fx.lessonIds[1],
          eventType: "progress",
          positionSeconds: 3600,
        },
      ])
      .run();

    expect(
      checkRefundRequest(db, purchase.id, base.user.id, NOW)
    ).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a Team Licence with a Claimed Seat", () => {
    const teamAdmin = fx.addStudent("Priya");
    const { purchase, seats } = fx.buySeats(teamAdmin.id, 3);
    fx.claimSeat(seats[0].id, fx.addStudent("Ben").id);

    expect(
      checkRefundRequest(db, purchase.id, teamAdmin.id, NOW)
    ).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("the newest Individual Purchase of a course", () => {
  it("is the Individual Purchase, not a newer Team Licence", () => {
    const individual = fx.buyForSelf(base.user.id, 3);
    fx.buySeats(base.user.id, 5, 1);

    expect(
      getNewestIndividualPurchase(db, base.user.id, base.course.id)?.id
    ).toBe(individual.id);
  });

  it("is the newest of several Individual Purchases", () => {
    fx.buyForSelf(base.user.id, 5);
    const newer = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 3950,
        country: "IN",
        createdAt: fx.daysBefore(2),
      })
      .returning()
      .get();

    expect(
      getNewestIndividualPurchase(db, base.user.id, base.course.id)
    ).toMatchObject({ id: newer.id, country: "IN" });
  });

  it("is nothing when the buyer holds only a Team Licence", () => {
    fx.buySeats(base.user.id, 5);

    expect(
      getNewestIndividualPurchase(db, base.user.id, base.course.id)
    ).toBeNull();
  });

  it("is nothing for a Student who only claimed a Seat", () => {
    const teamAdmin = fx.addStudent("Tess");
    const { seats } = fx.buySeats(teamAdmin.id, 2);
    const student = fx.addStudent("Sam");
    db.update(schema.coupons)
      .set({ redeemedByUserId: student.id, redeemedAt: fx.daysBefore(1) })
      .where(eq(schema.coupons.id, seats[0].id))
      .run();

    expect(
      getNewestIndividualPurchase(db, student.id, base.course.id)
    ).toBeNull();
  });
});

describe("the refund offer on the course page", () => {
  it("offers the newest Individual Purchase, not a newer Team Licence", () => {
    const individual = fx.buyForSelf(base.user.id, 3);
    fx.buySeats(base.user.id, 5, 1);

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toMatchObject(
      {
        purchaseId: individual.id,
        amount: 7900,
      }
    );
  });

  it("offers nothing once the purchase has been refunded", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);
    await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(getRefundOffer(db, base.user.id, base.course.id, NOW)).toBeNull();
  });
});

describe("approving a Refund Request", () => {
  it("removes the buyer's Enrollment but keeps their progress", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    db.insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: fx.lessonIds[0],
        status: LessonProgressStatus.Completed,
      })
      .run();
    const id = await fx.raise(purchase.id, base.user.id);

    const result = await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(result.ok).toBe(true);
    expect(isEnrolled(base.user.id)).toBe(false);
    expect(
      db
        .select()
        .from(schema.lessonProgress)
        .where(eq(schema.lessonProgress.userId, base.user.id))
        .all()
    ).toHaveLength(1);

    const refundRequest = db
      .select()
      .from(schema.refunds)
      .where(eq(schema.refunds.id, id))
      .get();
    expect(refundRequest).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByUserId: fx.platformAdmin.id,
    });
  });

  it("keeps the buyer's Bookmarks and Notes", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    toggleBookmark(db, base.user.id, fx.lessonIds[0], NOW);
    saveNote(db, base.user.id, fx.lessonIds[0], "Come back to this", NOW);
    const id = await fx.raise(purchase.id, base.user.id);

    await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(isEnrolled(base.user.id)).toBe(false);
    expect(isBookmarked(db, base.user.id, fx.lessonIds[0])).toBe(true);
    expect(getNote(db, base.user.id, fx.lessonIds[0])?.body).toBe(
      "Come back to this"
    );
  });

  it("keeps the buyer's Enrollment if they also hold a Claimed Seat for the course", async () => {
    const priya = fx.addStudent("Priya");
    const { seats } = fx.buySeats(priya.id, 2);
    // Liam claims a Seat first, so his Enrollment came from it.
    fx.claimSeat(seats[0].id, base.user.id);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: fx.daysBefore(2),
      })
      .returning()
      .get();
    const id = await fx.raise(purchase.id, base.user.id);

    await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(isEnrolled(base.user.id)).toBe(true);
  });

  it("makes a Team Licence's Unclaimed Seats unclaimable", async () => {
    const priya = fx.addStudent("Priya");
    const { purchase, seats } = fx.buySeats(priya.id, 2);
    const id = await fx.raise(purchase.id, priya.id);

    const result = await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(result.ok).toBe(true);
    for (const seat of seats) {
      expect(getSeatAvailability(db, getSeat(seat.id))).toBe("refunded");
    }
  });

  it("refuses a Team Licence whose Seat was claimed after the request", async () => {
    const priya = fx.addStudent("Priya");
    const { purchase, seats } = fx.buySeats(priya.id, 2);
    const id = await fx.raise(purchase.id, priya.id);
    // Seats are on hold while Open, but older data can still hold a claim.
    fx.claimSeat(seats[0].id, fx.addStudent("Ben").id);

    expect(
      await approveRefundRequest(
        db,
        id,
        fx.platformAdmin.id,
        null,
        NOW,
        notifications
      )
    ).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(getSeatAvailability(db, getSeat(seats[1].id))).toBe("on_hold");
  });

  it("lets the first decision win", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);
    await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(
      await declineRefundRequest(
        db,
        id,
        fx.platformAdmin.id,
        "Too late.",
        NOW,
        notifications
      )
    ).toMatchObject({
      ok: false,
      status: 409,
      error: "This refund request was already approved.",
    });
  });

  it("emails the buyer that the refund is on its way", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);

    const result = await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.email.to).toBe("test@example.com");
    expect(result.email.subject).toBe("Refund approved — Test Course");
    expect(result.email.body).toContain("$79.00");
  });
});

describe("declining a Refund Request", () => {
  it("needs a note", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);

    expect(
      await declineRefundRequest(
        db,
        id,
        fx.platformAdmin.id,
        "  ",
        NOW,
        notifications
      )
    ).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("keeps the buyer's Enrollment and lets them raise a new Refund Request", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);

    const result = await declineRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      "You finished the course.",
      NOW,
      notifications
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.email.body).toContain("You finished the course.");
    expect(isEnrolled(base.user.id)).toBe(true);
    expect(checkRefundRequest(db, purchase.id, base.user.id, NOW).ok).toBe(
      true
    );
  });

  it("frees a Team Licence's Seats again", async () => {
    const priya = fx.addStudent("Priya");
    const { purchase, seats } = fx.buySeats(priya.id, 1);
    const id = await fx.raise(purchase.id, priya.id);
    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("on_hold");

    await declineRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      "Seats are in use.",
      NOW,
      notifications
    );

    expect(getSeatAvailability(db, getSeat(seats[0].id))).toBe("available");
  });
});
