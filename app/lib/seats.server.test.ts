import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { getCouponByCode, redeemSeat } from "./seats.server";
import { isUserEnrolled } from "./enrollments.server";
import { raiseRefundRequest } from "./refunds.server";
import { noopNotifications } from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  admin = db
    .insert(schema.users)
    .values({
      name: "Tina Admin",
      email: "tina@example.com",
      role: UserRole.Student,
    })
    .returning()
    .get();
});

function buySeats(seats: number, country: string | null) {
  const daysAgo = new Date(NOW);
  daysAgo.setDate(daysAgo.getDate() - 3);
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: admin.id,
      courseId: base.course.id,
      amountPaid: 7900 * seats,
      country,
      createdAt: daysAgo.toISOString(),
    })
    .returning()
    .get();
  const codes = Array.from(
    { length: seats },
    (_, i) =>
      db
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code: `SEAT-${purchase.id}-${i}`,
          purchaseId: purchase.id,
        })
        .returning()
        .get().code
  );
  return { purchase, codes };
}

function addStudent(name: string) {
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

describe("redeeming a Seat", () => {
  it("claims an available Seat and enrolls the claimer", () => {
    const { codes } = buySeats(2, "PT");
    const claimer = addStudent("Carla");

    const result = redeemSeat(db, codes[0], claimer.id, "PT", NOW);

    if (!result.ok) throw new Error(result.error);

    expect(result.enrollment).toMatchObject({
      userId: claimer.id,
      courseId: base.course.id,
      enrolledAt: NOW.toISOString(),
    });
    expect(isUserEnrolled(db, claimer.id, base.course.id)).toBe(true);
    expect(getCouponByCode(db, codes[0])).toMatchObject({
      redeemedByUserId: claimer.id,
      redeemedAt: NOW.toISOString(),
    });
  });

  it("rejects an unknown code", () => {
    const claimer = addStudent("Carla");

    const result = redeemSeat(db, "NOPE", claimer.id, "PT", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Coupon not found",
    });
  });

  it("rejects a Seat that has already been claimed", () => {
    const { codes } = buySeats(1, "PT");
    const first = redeemSeat(db, codes[0], addStudent("Carla").id, "PT", NOW);
    if (!first.ok) throw new Error(first.error);

    const result = redeemSeat(db, codes[0], addStudent("Diogo").id, "PT", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "Coupon has already been redeemed",
    });
  });

  it("holds a Seat while its licence has an Open Refund Request", async () => {
    const { purchase, codes } = buySeats(2, "PT");
    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      admin.id,
      "It was not what I expected.",
      NOW,
      noopNotifications()
    );
    if (!raised.ok) throw new Error(raised.error);

    const result = redeemSeat(db, codes[0], addStudent("Carla").id, "PT", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error:
        "This seat can't be claimed right now. Ask the person who shared it with you.",
    });
  });

  it("rejects a Seat from an approved refund", () => {
    const { codes } = buySeats(1, "PT");
    db.update(schema.coupons)
      .set({ refundedAt: NOW.toISOString() })
      .where(eq(schema.coupons.code, codes[0]))
      .run();

    const result = redeemSeat(db, codes[0], addStudent("Carla").id, "PT", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error:
        "This seat is no longer available. Ask the person who shared it with you.",
    });
  });

  it("rejects a claimer who already holds an Enrollment", () => {
    const { codes } = buySeats(2, "PT");
    const claimer = addStudent("Carla");
    const first = redeemSeat(db, codes[0], claimer.id, "PT", NOW);
    if (!first.ok) throw new Error(first.error);

    const result = redeemSeat(db, codes[1], claimer.id, "PT", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: "You are already enrolled in this course",
    });
  });

  it("rejects a claim from another country than the purchase", () => {
    const { codes } = buySeats(1, "PT");

    const result = redeemSeat(db, codes[0], addStudent("Carla").id, "US", NOW);

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error:
        "This coupon can only be redeemed from the same country as the purchaser",
    });
  });

  it("allows a Seat bought without a country", () => {
    const { codes } = buySeats(1, null);
    const claimer = addStudent("Carla");

    const result = redeemSeat(db, codes[0], claimer.id, "US", NOW);

    expect(result.ok).toBe(true);
  });
});
