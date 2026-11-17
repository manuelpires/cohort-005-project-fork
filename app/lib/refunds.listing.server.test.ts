import { describe, it, expect, beforeEach, vi } from "vitest";

import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { LessonProgressStatus, RefundStatus, UserRole } from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  listRefundRequestsForBuyer,
  listRefundRequestsForReview,
  listTeamLicences,
  raiseRefundRequest,
} from "./refunds.server";
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

describe("listing Refund Requests", () => {
  it("shows a Platform Admin live figures and the rules a request breaks", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);
    // Since raising the request, the buyer has finished half the course.
    db.insert(schema.lessonProgress)
      .values(
        fx.lessonIds.slice(0, 2).map((lessonId) => ({
          userId: base.user.id,
          lessonId,
          status: LessonProgressStatus.Completed,
        }))
      )
      .run();

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row).toMatchObject({
      id,
      buyerName: "Test User",
      daysSincePurchase: 3,
      figures: {
        kind: "individual_purchase",
        lessonsCompleted: 2,
        lessonCount: 4,
      },
      ruleBreaks: ["completed_too_much"],
      canApprove: true,
    });
  });

  it("shows a Team Licence's Seats instead of the buyer's progress", async () => {
    const priya = fx.addStudent("Priya");
    const { purchase } = fx.buySeats(priya.id, 3);
    await fx.raise(purchase.id, priya.id);

    const [row] = listRefundRequestsForReview(db, RefundStatus.Open, NOW);

    expect(row.figures).toEqual({
      kind: "team_licence",
      seatCount: 3,
      claimedSeatCount: 0,
    });
  });

  it("lists only the requested status, oldest first", async () => {
    const first = fx.buyForSelf(base.user.id);
    const ben = fx.addStudent("Ben");
    const second = fx.buyForSelf(ben.id);
    const firstId = await fx.raise(first.id, base.user.id);
    const secondId = await raiseRefundRequest(
      db,
      second.id,
      ben.id,
      "Changed my mind.",
      new Date(NOW.getTime() + 60_000),
      notifications
    );
    if (!secondId.ok) throw new Error(secondId.error);

    expect(
      listRefundRequestsForReview(db, RefundStatus.Open, NOW).map((r) => r.id)
    ).toEqual([firstId, secondId.refundRequestId]);

    await approveRefundRequest(
      db,
      firstId,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(
      listRefundRequestsForReview(db, RefundStatus.Approved, NOW)
    ).toMatchObject([{ id: firstId, decidedByName: "Pat Admin" }]);
  });

  it("shows a buyer their decided requests with the decline note", async () => {
    const purchase = fx.buyForSelf(base.user.id);
    const id = await fx.raise(purchase.id, base.user.id);
    await declineRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      "Past half way.",
      NOW,
      notifications
    );

    expect(listRefundRequestsForBuyer(db, base.user.id)).toMatchObject([
      { id, status: RefundStatus.Declined, decisionNote: "Past half way." },
    ]);
  });

  it("lists a Team Admin's Team Licences and whether each can be refunded", () => {
    const priya = fx.addStudent("Priya");
    fx.buySeats(priya.id, 2);
    const { seats } = fx.buySeats(priya.id, 2);
    fx.claimSeat(seats[0].id, fx.addStudent("Ben").id);

    expect(listTeamLicences(db, priya.id, NOW)).toMatchObject([
      { seatCount: 2, claimedSeatCount: 1, canRequestRefund: false },
      { seatCount: 2, claimedSeatCount: 0, canRequestRefund: true },
    ]);
  });
});

describe("the Refund Request Notifications", () => {
  const testUser = {
    name: "Test User",
    email: "test@example.com",
    avatarUrl: null,
  };

  function sentOf(kind: string) {
    return notifications.sent.filter((n) => n.kind === kind);
  }

  it("confirms the Refund Request to the buyer", async () => {
    const purchase = fx.buyForSelf(base.user.id, 3, 7900);

    const id = await fx.raise(purchase.id, base.user.id);

    expect(sentOf("refund-requested")).toEqual([
      {
        kind: "refund-requested",
        idempotencyKey: `refund-requested:${id}`,
        recipient: { id: base.user.id, ...testUser },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          amount: "$79.00",
        },
      },
    ]);
  });

  it("tells every Platform Admin, and nobody else, about the Open Refund Request", async () => {
    const sam = db
      .insert(schema.users)
      .values({
        name: "Sam Admin",
        email: "sam@example.com",
        role: UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = fx.buyForSelf(base.user.id, 3, 7900);

    const id = await fx.raise(purchase.id, base.user.id);

    const open = sentOf("refund-request-open");
    expect(open.map((n) => n.recipient.id).sort()).toEqual(
      [fx.platformAdmin.id, sam.id].sort()
    );
    expect(open[0]).toEqual({
      kind: "refund-request-open",
      idempotencyKey: `refund-request-open:${id}`,
      recipient: {
        id: fx.platformAdmin.id,
        name: "Pat Admin",
        email: "pat@example.com",
        avatarUrl: null,
      },
      actor: { id: base.user.id, ...testUser },
      data: {
        refundRequestId: id,
        buyerName: "Test User",
        courseTitle: "Test Course",
        amount: "$79.00",
        reason: "It was not what I expected.",
        url: "/admin/refunds",
      },
    });
  });

  it("tells the buyer their Individual Purchase refund was approved", async () => {
    const purchase = fx.buyForSelf(base.user.id, 3, 7900);
    const id = await fx.raise(purchase.id, base.user.id);

    await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      "Sorry it didn't work out.",
      NOW,
      notifications
    );

    expect(sentOf("refund-approved")).toEqual([
      {
        kind: "refund-approved",
        idempotencyKey: `refund-approved:${id}`,
        recipient: { id: base.user.id, ...testUser },
        actor: {
          id: fx.platformAdmin.id,
          name: "Pat Admin",
          email: "pat@example.com",
          avatarUrl: null,
        },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          purchaseKind: "individual_purchase",
          amount: "$79.00",
          decisionNote: "Sorry it didn't work out.",
          url: "/settings",
        },
      },
    ]);
  });

  it("tells a Team Admin their Team Licence refund was declined", async () => {
    const priya = fx.addStudent("Priya");
    const { purchase } = fx.buySeats(priya.id, 2);
    const id = await fx.raise(purchase.id, priya.id);

    await declineRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      "  Seats are in use.  ",
      NOW,
      notifications
    );

    expect(sentOf("refund-declined")).toEqual([
      {
        kind: "refund-declined",
        idempotencyKey: `refund-declined:${id}`,
        recipient: {
          id: priya.id,
          name: "Priya",
          email: "priya@example.com",
          avatarUrl: null,
        },
        actor: {
          id: fx.platformAdmin.id,
          name: "Pat Admin",
          email: "pat@example.com",
          avatarUrl: null,
        },
        data: {
          refundRequestId: id,
          courseTitle: "Test Course",
          purchaseKind: "team_licence",
          amount: "$158.00",
          decisionNote: "Seats are in use.",
          url: "/team",
        },
      },
    ]);
    expect(sentOf("refund-approved")).toEqual([]);
  });

  it("tells a Team Admin their Team Licence refund was approved, with no note", async () => {
    const priya = fx.addStudent("Priya");
    const { purchase } = fx.buySeats(priya.id, 2);
    const id = await fx.raise(purchase.id, priya.id);

    await approveRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      null,
      NOW,
      notifications
    );

    expect(sentOf("refund-approved")).toMatchObject([
      {
        idempotencyKey: `refund-approved:${id}`,
        recipient: { id: priya.id },
        data: {
          purchaseKind: "team_licence",
          decisionNote: null,
          url: "/team",
        },
      },
    ]);
  });

  it("still raises and decides Refund Requests, with their emails, when Knock is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    notifications.failWith(new Error("Knock is down"));
    const purchase = fx.buyForSelf(base.user.id);

    const raised = await raiseRefundRequest(
      db,
      purchase.id,
      base.user.id,
      "Nope.",
      NOW,
      notifications
    );
    if (!raised.ok) throw new Error(raised.error);
    const declined = await declineRefundRequest(
      db,
      raised.refundRequestId,
      fx.platformAdmin.id,
      "No.",
      NOW,
      notifications
    );

    expect(raised.email.to).toBe("test@example.com");
    expect(declined).toMatchObject({
      ok: true,
      email: { to: "test@example.com" },
    });
    for (const key of [
      "refund-requested:",
      "refund-request-open:",
      "refund-declined:",
    ]) {
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(key),
        "Knock is down"
      );
    }
    error.mockRestore();
  });

  it("sends nothing when a decision is refused", async () => {
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
    notifications.sent.length = 0;

    await declineRefundRequest(
      db,
      id,
      fx.platformAdmin.id,
      "Too late.",
      NOW,
      notifications
    );

    expect(notifications.sent).toEqual([]);
  });
});
