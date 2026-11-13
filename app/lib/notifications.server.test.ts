import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  archiveCommentNotifications,
  fakeNotifications,
  syncNotificationsUser,
  translateKnockPreferences,
  triggerNotification,
  type NotificationsPort,
} from "./notifications.server";

const USER = {
  id: 1,
  name: "Emma Wilson",
  email: "emma.wilson@student.dev",
  avatarUrl: "https://api.dicebear.com/9.x/avataaars/svg?seed=emma",
};

function throwingPort(): NotificationsPort {
  return {
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
    async archiveCommentNotifications() {
      throw new Error("Knock rejected the key");
    },
  };
}

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

    await expect(
      syncNotificationsUser(USER, throwingPort())
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe("triggerNotification", () => {
  it("records the trigger through the fake port", async () => {
    const notifications = fakeNotifications();
    const trigger = {
      workflow: "refund-request-raised" as const,
      recipients: [USER],
      data: { kind: "refund-request-confirmed" },
      idempotencyKey: "refund-raised:1",
    };

    await triggerNotification(trigger, notifications);

    expect(notifications.triggers).toEqual([
      { ...trigger, deliveredTo: [USER.id], suppressedFor: [] },
    ]);
  });

  it("records a discussion trigger and lands it in the feed", async () => {
    const notifications = fakeNotifications();

    await triggerNotification(
      {
        workflow: "discussion-question-created",
        recipients: [USER],
        actor: USER,
        data: { commentId: 7 },
        idempotencyKey: "discussion-question-created:7",
      },
      notifications
    );

    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.messagesFor(USER.id)).toHaveLength(1);
  });

  it("logs and swallows a failing trigger instead of throwing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      triggerNotification(
        {
          workflow: "discussion-reply-created",
          recipients: [USER],
          data: { commentId: 8 },
          idempotencyKey: "discussion-reply-created:8",
        },
        throwingPort()
      )
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe("triggering a notification workflow through the fake", () => {
  it("delivers to a recipient who has the workflow's category on", async () => {
    const notifications = fakeNotifications();
    await notifications.setPreferences(USER.id, { enrollments: true });

    await notifications.trigger({
      workflow: "enrollment-created",
      recipients: [USER],
      actor: { ...USER, id: 2 },
      data: { studentName: "Emma Wilson", courseTitle: "Test Course" },
      idempotencyKey: "enrollment-created:1",
    });

    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.triggers[0]).toMatchObject({
      workflow: "enrollment-created",
      recipients: [USER],
      actor: { ...USER, id: 2 },
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
      recipients: [USER],
      data: {},
      idempotencyKey: "enrollment-created:1",
    });

    expect(notifications.triggers[0].deliveredTo).toEqual([]);
    expect(notifications.triggers[0].suppressedFor).toEqual([USER.id]);
    expect(notifications.messagesFor(USER.id)).toHaveLength(0);
  });

  it("delivers to a recipient with no preference set yet", async () => {
    const notifications = fakeNotifications();

    await notifications.trigger({
      workflow: "seat-claimed",
      recipients: [USER],
      data: {},
      idempotencyKey: "seat-claimed:1",
    });

    expect(notifications.triggers[0].deliveredTo).toEqual([USER.id]);
    expect(notifications.triggers[0].suppressedFor).toEqual([]);
  });
});

describe("translateKnockPreferences", () => {
  it("reads a feed-channel value the vendor reported, and a whole-category boolean", () => {
    expect(
      translateKnockPreferences({
        categories: {
          "seat-claims": { channel_types: { in_app_feed: false } },
          "discussion-replies": true,
        },
      })
    ).toEqual({
      "seat-claims": false,
      "discussion-replies": true,
    });
  });

  it("treats a category whose feed channel the vendor never reported as absent, not off", () => {
    const preferences = translateKnockPreferences({
      categories: {
        "refund-request-updates": { channel_types: { in_app_feed: true } },
        "open-refund-requests": { channel_types: {} },
        "seat-claims": {},
        enrollments: undefined,
      },
    });

    expect(preferences).toEqual({ "refund-request-updates": true });
  });

  it("treats a non-boolean feed-channel value as absent too", () => {
    expect(
      translateKnockPreferences({
        categories: {
          enrollments: { channel_types: { in_app_feed: "on" } },
        },
      })
    ).toEqual({});
  });

  it("reads a set the vendor would not return as empty", () => {
    expect(translateKnockPreferences(null)).toEqual({});
  });
});

describe("archiveCommentNotifications", () => {
  it("archives only the messages the comment caused", async () => {
    const notifications = fakeNotifications();
    await notifications.trigger({
      workflow: "discussion-question-created",
      recipients: [USER],
      data: { commentId: 7 },
      idempotencyKey: "discussion-question-created:7",
    });
    await notifications.trigger({
      workflow: "discussion-reply-created",
      recipients: [USER],
      data: { commentId: 8 },
      idempotencyKey: "discussion-reply-created:8",
    });

    await archiveCommentNotifications(7, notifications);

    expect(notifications.messagesFor(USER.id)).toHaveLength(1);
    expect(notifications.messagesFor(USER.id)[0].workflow).toBe(
      "discussion-reply-created"
    );
  });

  it("logs and swallows a failing archive instead of throwing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      archiveCommentNotifications(7, throwingPort())
    ).resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
