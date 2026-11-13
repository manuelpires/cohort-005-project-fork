import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fakeNotifications,
  syncNotificationsUser,
  type NotificationsPort,
} from "./notifications.server";
const USER = {
  id: 1,
  name: "Emma Wilson",
  email: "emma.wilson@student.dev",
  avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=emma",
};

describe("syncNotificationsUser", () => {
  it("identifies the user to the vendor with name, email and avatar", async () => {
    const notifications = fakeNotifications();

    await syncNotificationsUser(USER, notifications);

    expect(notifications.users.get(USER.id)).toEqual(USER);
  });

  it("writes the default preference set when the user has none yet", async () => {
    const notifications = fakeNotifications();

    await syncNotificationsUser(USER, notifications);

    expect(notifications.preferenceSets.get(USER.id)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES
    );
  });

  it("does not overwrite a preference set the user already has", async () => {
    const notifications = fakeNotifications();
    // The user opted in to Enrollments after their first sync.
    await notifications.setPreferences(USER.id, { enrollments: true });

    await syncNotificationsUser(USER, notifications);

    expect(notifications.preferenceSets.get(USER.id)).toEqual({
      enrollments: true,
    });
    expect(notifications.preferenceWrites).toHaveLength(1);
  });

  it("logs and swallows a failing sync instead of throwing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const port: NotificationsPort = {
      async identifyUser() {
        throw new Error("Knock rejected the key");
      },
      async getPreferences() {
        throw new Error("Knock rejected the key");
      },
      async setPreferences() {
        throw new Error("Knock rejected the key");
      },
      async trigger() {
        throw new Error("Knock rejected the key");
      },
    };

    await expect(syncNotificationsUser(USER, port)).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe("triggering a notification workflow through the fake", () => {
  it("records the trigger and delivers to a recipient who has the workflow's category on", async () => {
    const notifications = fakeNotifications();
    await notifications.setPreferences(USER.id, { enrollments: true });

    await notifications.trigger({
      workflow: "enrollment-created",
      recipients: [USER.id],
      actor: 2,
      data: { studentName: "Emma Wilson", courseTitle: "Test Course" },
      idempotencyKey: "enrollment-created:1",
    });

    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.triggers[0]).toMatchObject({
      workflow: "enrollment-created",
      recipients: [USER.id],
      actor: 2,
      data: { studentName: "Emma Wilson", courseTitle: "Test Course" },
      idempotencyKey: "enrollment-created:1",
      deliveredTo: [USER.id],
      suppressedFor: [],
    });
  });

  it("suppresses a recipient who muted the workflow's category", async () => {
    const notifications = fakeNotifications();
    await notifications.setPreferences(USER.id, { enrollments: false });

    await notifications.trigger({
      workflow: "enrollment-created",
      recipients: [USER.id],
      data: {},
      idempotencyKey: "enrollment-created:1",
    });

    expect(notifications.triggers[0].deliveredTo).toEqual([]);
    expect(notifications.triggers[0].suppressedFor).toEqual([USER.id]);
  });

  it("delivers to a recipient with no preference set yet", async () => {
    const notifications = fakeNotifications();

    await notifications.trigger({
      workflow: "seat-claimed",
      recipients: [USER.id],
      data: {},
      idempotencyKey: "seat-claimed:1",
    });

    expect(notifications.triggers[0].deliveredTo).toEqual([USER.id]);
    expect(notifications.triggers[0].suppressedFor).toEqual([]);
  });
});
