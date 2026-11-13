import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  enrollOnPurchase,
  isUserEnrolled,
  purchaseTeamLicence,
} from "./enrollments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

describe("enrolling on an Individual Purchase", () => {
  it("records the Purchase and enrolls the buyer", async () => {
    const result = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      "PT",
      NOW
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.purchase).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      amountPaid: 7900,
      country: "PT",
      createdAt: NOW.toISOString(),
    });
    expect(result.enrollment).toMatchObject({
      userId: base.user.id,
      courseId: base.course.id,
      enrolledAt: NOW.toISOString(),
    });
    expect(isUserEnrolled(db, base.user.id, base.course.id)).toBe(true);
  });

  it("refuses a buyer who already holds an Enrollment", async () => {
    const first = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      null,
      NOW
    );
    if (!first.ok) throw new Error(first.error);

    const again = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      null,
      NOW
    );

    expect(again).toMatchObject({
      ok: false,
      status: 409,
      error: "User is already enrolled in this course",
    });
  });

  it("refuses a course that doesn't exist", async () => {
    const result = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id + 1000,
      7900,
      null,
      NOW
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Course not found",
    });
  });
});

describe("buying a Team Licence", () => {
  it("grants Seats without enrolling the buyer", async () => {
    const result = await purchaseTeamLicence(
      db,
      base.user.id,
      base.course.id,
      15800,
      "PT",
      2,
      NOW
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.coupons).toHaveLength(2);
    expect(result.coupons[0]).toMatchObject({
      courseId: base.course.id,
      redeemedByUserId: null,
    });
    expect(isUserEnrolled(db, base.user.id, base.course.id)).toBe(false);
  });
});
