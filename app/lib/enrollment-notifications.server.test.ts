import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import { eq } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fakeNotifications,
  syncNotificationsUser,
  type FakeNotifications,
  type NotificationsPort,
} from "./notifications.server";
import {
  enrollOnPurchase,
  isUserEnrolled,
  purchaseTeamLicence,
} from "./enrollments.server";
import { redeemSeat } from "./seats.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let notifications: FakeNotifications;

beforeEach(async () => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = fakeNotifications();
  // Synced users carry the default preference set: Enrollments off,
  // everything else on.
  await syncNotificationsUser(base.instructor, notifications);
});

describe("notifying the Instructor about a new Enrollment", () => {
  it("triggers an Enrollment notification but suppresses it while the Enrollments preference is off", async () => {
    const result = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      "PT",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.triggers[0]).toMatchObject({
      workflow: "enrollment-created",
      recipients: [{ id: base.instructor.id }],
      actor: { id: base.user.id },
      idempotencyKey: `enrollment-created:${result.enrollment.id}`,
      deliveredTo: [],
      suppressedFor: [base.instructor.id],
    });
  });

  it("delivers to the Instructor once they opt in to Enrollments, naming the Student and the course", async () => {
    await notifications.setPreferences(base.instructor.id, {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      enrollments: true,
    });

    const result = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      "PT",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.triggers[0]).toMatchObject({
      workflow: "enrollment-created",
      recipients: [{ id: base.instructor.id }],
      actor: { id: base.user.id },
      data: {
        studentName: base.user.name,
        courseTitle: base.course.title,
        url: `/instructor/${base.course.id}/students`,
      },
      idempotencyKey: `enrollment-created:${result.enrollment.id}`,
      deliveredTo: [base.instructor.id],
      suppressedFor: [],
    });
  });

  it("notifies again when a Lapsed Student enrolls again, under a fresh idempotency key", async () => {
    await notifications.setPreferences(base.instructor.id, {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      enrollments: true,
    });

    const first = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      "PT",
      NOW,
      notifications
    );
    if (!first.ok) throw new Error(first.error);

    // The Student lapses: an approved Refund Request deleted their Enrollment.
    db.delete(schema.enrollments)
      .where(eq(schema.enrollments.id, first.enrollment.id))
      .run();

    const again = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      "PT",
      NOW,
      notifications
    );
    if (!again.ok) throw new Error(again.error);

    expect(notifications.triggers).toHaveLength(2);
    expect(notifications.triggers[1].idempotencyKey).toBe(
      `enrollment-created:${again.enrollment.id}`
    );
    expect(notifications.triggers[1].idempotencyKey).not.toBe(
      notifications.triggers[0].idempotencyKey
    );
    expect(notifications.triggers[1].deliveredTo).toEqual([base.instructor.id]);
  });

  it("buys a Team Licence without notifying anybody: a licence grants Seats, not an Enrollment", async () => {
    const result = await purchaseTeamLicence(
      db,
      base.user.id,
      base.course.id,
      15800,
      "PT",
      2,
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toEqual([]);
  });
});

describe("notifying the Team Admin about a claimed Seat", () => {
  let teamAdmin: typeof schema.users.$inferSelect;

  function buyTeamLicence(seats: number) {
    const daysAgo = new Date(NOW);
    daysAgo.setDate(daysAgo.getDate() - 3);
    const team = db.insert(schema.teams).values({}).returning().get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: teamAdmin.id,
        courseId: base.course.id,
        amountPaid: 7900 * seats,
        country: "PT",
        createdAt: daysAgo.toISOString(),
      })
      .returning()
      .get();
    const coupons = Array.from({ length: seats }, (_, i) =>
      db
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code: `SEAT-${purchase.id}-${i}`,
          purchaseId: purchase.id,
        })
        .returning()
        .get()
    );
    return { purchase, coupons };
  }

  beforeEach(async () => {
    teamAdmin = db
      .insert(schema.users)
      .values({
        name: "Tia Admin",
        email: "tia@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    await syncNotificationsUser(teamAdmin, notifications);
  });

  it("notifies the Team Admin who owns the licence, with claimer, course and Seats remaining", async () => {
    const { coupons } = buyTeamLicence(3);
    const claimer = db
      .insert(schema.users)
      .values({
        name: "Carla Claimer",
        email: "carla@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();

    const result = await redeemSeat(
      db,
      coupons[0].code,
      claimer.id,
      "PT",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    const seatClaimed = notifications.triggers.find(
      (trigger) => trigger.workflow === "seat-claimed"
    );
    expect(seatClaimed).toMatchObject({
      recipients: [{ id: teamAdmin.id }],
      actor: { id: claimer.id },
      data: {
        claimerName: claimer.name,
        courseTitle: base.course.title,
        seatsLeft: 2,
        url: "/team",
      },
      idempotencyKey: `seat-claimed:${coupons[0].id}`,
      deliveredTo: [teamAdmin.id],
      suppressedFor: [],
    });
  });

  it("also notifies the course's Instructor about the Enrollment the claim grants", async () => {
    await notifications.setPreferences(base.instructor.id, {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      enrollments: true,
    });
    const { coupons } = buyTeamLicence(1);
    const claimer = db
      .insert(schema.users)
      .values({
        name: "Carla Claimer",
        email: "carla@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();

    const result = await redeemSeat(
      db,
      coupons[0].code,
      claimer.id,
      "PT",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toHaveLength(2);
    expect(notifications.triggers[1]).toMatchObject({
      workflow: "enrollment-created",
      recipients: [{ id: base.instructor.id }],
      actor: { id: claimer.id },
      data: {
        studentName: claimer.name,
        courseTitle: base.course.title,
      },
      idempotencyKey: `enrollment-created:${result.enrollment.id}`,
      deliveredTo: [base.instructor.id],
    });
  });

  it("acknowledges each claim individually, counting down the Seats remaining", async () => {
    const { coupons } = buyTeamLicence(2);
    const carla = db
      .insert(schema.users)
      .values({
        name: "Carla Claimer",
        email: "carla@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const diogo = db
      .insert(schema.users)
      .values({
        name: "Diogo Doe",
        email: "diogo@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();

    const first = await redeemSeat(
      db,
      coupons[0].code,
      carla.id,
      "PT",
      NOW,
      notifications
    );
    if (!first.ok) throw new Error(first.error);
    const second = await redeemSeat(
      db,
      coupons[1].code,
      diogo.id,
      "PT",
      NOW,
      notifications
    );
    if (!second.ok) throw new Error(second.error);

    const seatClaims = notifications.triggers.filter(
      (trigger) => trigger.workflow === "seat-claimed"
    );
    expect(seatClaims).toHaveLength(2);
    expect(seatClaims[0].data.seatsLeft).toBe(1);
    expect(seatClaims[1].data.seatsLeft).toBe(0);
    expect(seatClaims[0].idempotencyKey).toBe(`seat-claimed:${coupons[0].id}`);
    expect(seatClaims[1].idempotencyKey).toBe(`seat-claimed:${coupons[1].id}`);
  });

  it("does not notify a Team Admin who claims their own Seat", async () => {
    const { coupons } = buyTeamLicence(2);

    const result = await redeemSeat(
      db,
      coupons[0].code,
      teamAdmin.id,
      "PT",
      NOW,
      notifications
    );

    expect(result.ok).toBe(true);
    expect(
      notifications.triggers.some(
        (trigger) => trigger.workflow === "seat-claimed"
      )
    ).toBe(false);
  });

  it("never fails the domain action when the vendor is down", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const down: NotificationsPort = {
      identifyUser: (user) => notifications.identifyUser(user),
      getPreferences: (userId) => notifications.getPreferences(userId),
      setPreferences: (userId, preferences) =>
        notifications.setPreferences(userId, preferences),
      async trigger() {
        throw new Error("Knock is unreachable");
      },
      async archiveCommentNotifications() {
        throw new Error("Knock is unreachable");
      },
    };

    const purchase = await enrollOnPurchase(
      db,
      base.user.id,
      base.course.id,
      7900,
      "PT",
      NOW,
      down
    );
    const { coupons } = buyTeamLicence(1);
    const claimer = db
      .insert(schema.users)
      .values({
        name: "Carla Claimer",
        email: "carla@example.com",
        role: UserRole.Student,
      })
      .returning()
      .get();
    const claim = await redeemSeat(
      db,
      coupons[0].code,
      claimer.id,
      "PT",
      NOW,
      down
    );

    expect(purchase.ok).toBe(true);
    expect(claim.ok).toBe(true);
    expect(isUserEnrolled(db, base.user.id, base.course.id)).toBe(true);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("does not notify an Instructor who enrolls on their own course", async () => {
    const result = await enrollOnPurchase(
      db,
      base.instructor.id,
      base.course.id,
      7900,
      "PT",
      NOW,
      notifications
    );

    expect(result.ok).toBe(true);
    expect(notifications.triggers).toEqual([]);
  });
});
