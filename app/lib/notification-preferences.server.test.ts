import { describe, expect, it } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fakeNotifications,
  type NotificationsPort,
} from "./notifications.server";
import {
  mergeNotificationPreference,
  getNotificationPreferenceRows,
} from "./notification-preferences.server";

type TestDb = ReturnType<typeof createTestDb>;

async function seededUser(db: TestDb) {
  const { user } = seedBaseData(db);
  return user;
}

describe("mergeNotificationPreference", () => {
  it("flips one category and preserves the other five in the stored set", async () => {
    const db = createTestDb();
    const user = await seededUser(db);
    const notifications = fakeNotifications();
    await notifications.setPreferences(
      user.id,
      DEFAULT_NOTIFICATION_PREFERENCES
    );

    await mergeNotificationPreference(
      user.id,
      "enrollments",
      true,
      notifications
    );

    expect(notifications.preferenceSets.get(user.id)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      enrollments: true,
    });
  });

  it("writes the full set over the defaults for a person who was never synced", async () => {
    const db = createTestDb();
    const user = await seededUser(db);
    const notifications = fakeNotifications();

    await mergeNotificationPreference(
      user.id,
      "discussion-questions",
      false,
      notifications
    );

    expect(notifications.preferenceSets.get(user.id)).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      "discussion-questions": false,
    });
  });

  it("propagates a failing write so the card can toast and revert", async () => {
    const db = createTestDb();
    const user = await seededUser(db);
    const port: NotificationsPort = {
      async identifyUser() {},
      async getPreferences() {
        return null;
      },
      async setPreferences() {
        throw new Error("Knock rejected the key");
      },
      async trigger() {},
      async archiveCommentNotifications() {},
    };

    await expect(
      mergeNotificationPreference(user.id, "seat-claims", false, port)
    ).rejects.toThrow("Knock rejected the key");
  });
});

describe("getNotificationPreferenceRows", () => {
  it("shows a person with no purchases, courses or teams only Discussion Replies", async () => {
    const db = createTestDb();
    const { user } = seedBaseData(db);
    const notifications = fakeNotifications();

    const rows = await getNotificationPreferenceRows(
      db,
      user.id,
      notifications
    );

    expect(rows).toEqual([
      { category: "discussion-replies", label: "Discussion Replies", enabled: true },
    ]);
  });

  it("shows a buyer Refund Request updates but not Seat claims", async () => {
    const db = createTestDb();
    const { user, course } = seedBaseData(db);
    db.insert(schema.purchases)
      .values({
        userId: user.id,
        courseId: course.id,
        amountPaid: 7900,
        country: "US",
      })
      .run();
    const notifications = fakeNotifications();

    const rows = await getNotificationPreferenceRows(
      db,
      user.id,
      notifications
    );

    expect(rows.map((row) => row.category)).toEqual([
      "refund-request-updates",
      "discussion-replies",
    ]);
  });

  it("shows the buyer of a Team Licence Seat claims", async () => {
    const db = createTestDb();
    const { user, course } = seedBaseData(db);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: user.id,
        courseId: course.id,
        amountPaid: 7900,
        country: "US",
      })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: course.id,
        code: "SEAT-CODE-1",
        purchaseId: purchase.id,
      })
      .run();
    const notifications = fakeNotifications();

    const rows = await getNotificationPreferenceRows(
      db,
      user.id,
      notifications
    );

    expect(rows.map((row) => row.category)).toEqual([
      "refund-request-updates",
      "seat-claims",
      "discussion-replies",
    ]);
  });

  it("shows an Instructor who owns a course Enrollments (off by default) and Discussion Questions", async () => {
    const db = createTestDb();
    const { instructor } = seedBaseData(db);
    const notifications = fakeNotifications();

    const rows = await getNotificationPreferenceRows(
      db,
      instructor.id,
      notifications
    );

    expect(rows).toEqual([
      {
        category: "enrollments",
        label: "Enrollments",
        enabled: false,
      },
      {
        category: "discussion-questions",
        label: "Discussion Questions",
        enabled: true,
      },
      { category: "discussion-replies", label: "Discussion Replies", enabled: true },
    ]);
  });

  it("shows a Platform Admin Open Refund Requests", async () => {
    const db = createTestDb();
    const admin = db
      .insert(schema.users)
      .values({
        name: "Pat Admin",
        email: "pat@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const notifications = fakeNotifications();

    const rows = await getNotificationPreferenceRows(
      db,
      admin.id,
      notifications
    );

    expect(rows.map((row) => row.category)).toEqual([
      "open-refund-requests",
      "discussion-replies",
    ]);
  });

  it("lists every row in the card's order for a person who is all of them", async () => {
    const db = createTestDb();
    const { category } = seedBaseData(db);
    const everyone = db
      .insert(schema.users)
      .values({
        name: "Oak Everything",
        email: "oak@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const ownCourse = db
      .insert(schema.courses)
      .values({
        title: "Their Course",
        slug: "their-course",
        description: "d",
        salesCopy: "## s",
        instructorId: everyone.id,
        categoryId: category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: everyone.id,
        courseId: ownCourse.id,
        amountPaid: 7900,
        country: "US",
      })
      .returning()
      .get();
    const team = db.insert(schema.teams).values({}).returning().get();
    db.insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: ownCourse.id,
        code: "SEAT-CODE-2",
        purchaseId: purchase.id,
      })
      .run();
    const notifications = fakeNotifications();

    const rows = await getNotificationPreferenceRows(
      db,
      everyone.id,
      notifications
    );

    expect(rows).toEqual([
      { category: "refund-request-updates", label: "Refund Request updates", enabled: true },
      { category: "open-refund-requests", label: "Open Refund Requests", enabled: true },
      { category: "seat-claims", label: "Seat claims", enabled: true },
      { category: "enrollments", label: "Enrollments", enabled: false },
      { category: "discussion-questions", label: "Discussion Questions", enabled: true },
      { category: "discussion-replies", label: "Discussion Replies", enabled: true },
    ]);
  });

  it("reads the enabled values from the person's stored set over the defaults", async () => {
    const db = createTestDb();
    const { user } = seedBaseData(db);
    const notifications = fakeNotifications();
    await notifications.setPreferences(user.id, {
      "discussion-replies": false,
    });

    const rows = await getNotificationPreferenceRows(
      db,
      user.id,
      notifications
    );

    expect(rows).toEqual([
      {
        category: "discussion-replies",
        label: "Discussion Replies",
        enabled: false,
      },
    ]);
  });

  it("keeps a hidden switch's default and reveals it once the person qualifies", async () => {
    const db = createTestDb();
    const { user, course } = seedBaseData(db);
    const notifications = fakeNotifications();

    // No Purchase yet: the Refund Request updates switch is hidden, and a
    // flip elsewhere must not disturb the default it silently keeps.
    await mergeNotificationPreference(
      user.id,
      "discussion-replies",
      false,
      notifications
    );
    expect(
      notifications.preferenceSets.get(user.id)?.["refund-request-updates"]
    ).toBe(DEFAULT_NOTIFICATION_PREFERENCES["refund-request-updates"]);

    db.insert(schema.purchases)
      .values({
        userId: user.id,
        courseId: course.id,
        amountPaid: 7900,
        country: "US",
      })
      .run();

    const rows = await getNotificationPreferenceRows(
      db,
      user.id,
      notifications
    );

    expect(
      rows.find((row) => row.category === "refund-request-updates")
    ).toEqual({
      category: "refund-request-updates",
      label: "Refund Request updates",
      enabled: true,
    });
  });
});
