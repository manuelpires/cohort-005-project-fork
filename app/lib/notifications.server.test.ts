import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  fakeNotifications,
  syncNotificationsUser,
  triggerNotification,
  type NotificationsPort,
} from "./notifications.server";

const USER = {
  id: 1,
  name: "Emma Wilson",
  email: "emma.wilson@student.dev",
  avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=emma",
};

const TRIGGER = {
  workflow: "refund-request-raised" as const,
  recipientIds: [USER.id],
  data: { kind: "refund-request-confirmed" },
  idempotencyKey: "refund-raised:1",
};

describe("triggerNotification", () => {
  it("records the trigger through the fake port", async () => {
    const notifications = fakeNotifications();

    await triggerNotification(TRIGGER, notifications);

    expect(notifications.triggers).toEqual([TRIGGER]);
  });

  it("logs and swallows a failing trigger instead of throwing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const port: NotificationsPort = {
      async identifyUser() {},
      async getPreferences() {
        return null;
      },
      async setPreferences() {},
      async trigger() {
        throw new Error("Knock is down");
      },
    };

    await expect(triggerNotification(TRIGGER, port)).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

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
