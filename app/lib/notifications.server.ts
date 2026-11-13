import Knock from "@knocklabs/node";

// ─── Notification server port ───
// Knock delivers Notifications when KNOCK_SECRET_API_KEY is set. Without
// the key (local dev, tests) every call becomes a no-op, so the app runs
// keyless the way it runs without a Postmark token. Tests inject the
// in-memory fake instead and assert on what it recorded.

export type NotificationCategoryId =
  | "refund-request-updates"
  | "open-refund-requests"
  | "seat-claims"
  | "enrollments"
  | "discussion-questions"
  | "discussion-replies";

export type NotificationPreferences = Partial<
  Record<NotificationCategoryId, boolean>
>;

// "Off by default" for Enrollments is written by Cadence, not by Knock:
// the vendor's environment default is dashboard-only with no API, and the
// tenant default did not suppress delivery when tried.
export const DEFAULT_NOTIFICATION_PREFERENCES: Record<
  NotificationCategoryId,
  boolean
> = {
  "refund-request-updates": true,
  "open-refund-requests": true,
  "seat-claims": true,
  enrollments: false,
  "discussion-questions": true,
  "discussion-replies": true,
};

export type NotificationUser = {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
};

export type NotificationWorkflowKey = "seat-claimed" | "enrollment-created";

// Which preference category each workflow belongs to. In Knock the category
// is tagged on the workflow itself and evaluated per recipient at delivery
// time; the fake below mirrors those semantics for tests.
export const WORKFLOW_CATEGORIES: Record<
  NotificationWorkflowKey,
  NotificationCategoryId
> = {
  "seat-claimed": "seat-claims",
  "enrollment-created": "enrollments",
};

export type NotificationTrigger = {
  workflow: NotificationWorkflowKey;
  recipients: number[];
  actor?: number;
  data: Record<string, unknown>;
  idempotencyKey: string;
};

export interface NotificationsPort {
  identifyUser(user: NotificationUser): Promise<void>;
  getPreferences(userId: number): Promise<NotificationPreferences | null>;
  setPreferences(
    userId: number,
    preferences: NotificationPreferences
  ): Promise<void>;
  trigger(trigger: NotificationTrigger): Promise<void>;
}

// ─── Knock adapter ───
// The only code that speaks Knock's keys: category ids and the feed channel
// map to the vendor's category keys and in-app feed channel type, and
// Cadence user ids become strings. No code outside this section touches
// Knock. Untested by design — tests assert on the fake below instead, the
// way the Postmark transport is never exercised in vitest.

const KNOCK_CATEGORY_KEYS: Record<NotificationCategoryId, string> = {
  "refund-request-updates": "refund-request-updates",
  "open-refund-requests": "open-refund-requests",
  "seat-claims": "seat-claims",
  enrollments: "enrollments",
  "discussion-questions": "discussion-questions",
  "discussion-replies": "discussion-replies",
};

const KNOCK_FEED_CHANNEL_TYPE = "in_app_feed";

const KNOCK_WORKFLOW_KEYS: Record<NotificationWorkflowKey, string> = {
  "seat-claimed": "seat-claimed",
  "enrollment-created": "enrollment-created",
};

export function knockNotifications(secretKey: string): NotificationsPort {
  const knock = new Knock({ apiKey: secretKey });
  return {
    async identifyUser(user) {
      await knock.users.update(String(user.id), {
        name: user.name,
        email: user.email,
        avatar: user.avatarUrl,
      });
    },
    async getPreferences(userId) {
      const set = await knock.users
        .getPreferences(String(userId), "default")
        .catch(() => null);
      const preferences: NotificationPreferences = {};
      for (const category of Object.keys(
        KNOCK_CATEGORY_KEYS
      ) as NotificationCategoryId[]) {
        const setting = set?.categories?.[KNOCK_CATEGORY_KEYS[category]];
        if (setting === undefined) continue;
        if (typeof setting === "boolean") {
          preferences[category] = setting;
          continue;
        }
        const channelSetting = setting.channel_types?.[KNOCK_FEED_CHANNEL_TYPE];
        preferences[category] =
          typeof channelSetting === "boolean" ? channelSetting : false;
      }
      return Object.keys(preferences).length > 0 ? preferences : null;
    },
    async setPreferences(userId, preferences) {
      const categories: Record<
        string,
        { channel_types: Record<string, boolean> }
      > = {};
      for (const [category, on] of Object.entries(preferences)) {
        if (on === undefined) continue;
        categories[KNOCK_CATEGORY_KEYS[category as NotificationCategoryId]] = {
          channel_types: { [KNOCK_FEED_CHANNEL_TYPE]: on },
        };
      }
      await knock.users.setPreferences(String(userId), "default", {
        categories,
      });
    },
    async trigger(input) {
      await knock.workflows.trigger(
        KNOCK_WORKFLOW_KEYS[input.workflow],
        {
          recipients: input.recipients.map(String),
          actor: input.actor === undefined ? undefined : String(input.actor),
          data: input.data,
        },
        // Knock replays the original response for a repeated key, so a retry
        // layer added later cannot send duplicate Notifications.
        { idempotencyKey: input.idempotencyKey }
      );
    },
  };
}

// ─── In-memory fake (tests) and no-op (keyless dev) ───

export type RecordedNotificationTrigger = NotificationTrigger & {
  deliveredTo: number[];
  suppressedFor: number[];
};

export class FakeNotifications implements NotificationsPort {
  readonly users = new Map<number, NotificationUser>();
  readonly preferenceSets = new Map<number, NotificationPreferences>();
  readonly preferenceWrites: Array<{
    userId: number;
    preferences: NotificationPreferences;
  }> = [];
  readonly triggers: RecordedNotificationTrigger[] = [];

  async identifyUser(user: NotificationUser): Promise<void> {
    this.users.set(user.id, user);
  }

  async getPreferences(
    userId: number
  ): Promise<NotificationPreferences | null> {
    return this.preferenceSets.get(userId) ?? null;
  }

  async setPreferences(
    userId: number,
    preferences: NotificationPreferences
  ): Promise<void> {
    this.preferenceSets.set(userId, preferences);
    this.preferenceWrites.push({ userId, preferences: { ...preferences } });
  }

  async trigger(trigger: NotificationTrigger): Promise<void> {
    // Vendor semantics: each recipient's preference set is evaluated against
    // the workflow's category. A recipient with no set (never synced) gets
    // the workflow's default — delivery. "Off by default" for Enrollments is
    // written by Cadence's user sync, not by the vendor.
    const category = WORKFLOW_CATEGORIES[trigger.workflow];
    const deliveredTo: number[] = [];
    const suppressedFor: number[] = [];
    for (const recipient of trigger.recipients) {
      const muted = this.preferenceSets.get(recipient)?.[category] === false;
      if (muted) suppressedFor.push(recipient);
      else deliveredTo.push(recipient);
    }
    this.triggers.push({
      ...trigger,
      data: { ...trigger.data },
      deliveredTo,
      suppressedFor,
    });
  }
}

export function fakeNotifications(): FakeNotifications {
  return new FakeNotifications();
}

export function noopNotifications(): NotificationsPort {
  return {
    async identifyUser() {},
    async getPreferences() {
      return null;
    },
    async setPreferences() {},
    async trigger() {},
  };
}

// ─── Default selection and user sync ───

function knockSecretKey(): string | undefined {
  // Tests never resolve a real adapter: the vendor is observed through the
  // injected fake, and loadEnvFile below would otherwise find live keys.
  if (process.env.VITEST) return undefined;
  if (!process.env.KNOCK_SECRET_API_KEY) {
    try {
      // Vite doesn't put non-VITE_ vars on process.env, so load .env
      // ourselves. A missing .env just means keyless dev.
      process.loadEnvFile(".env");
    } catch {
      return undefined;
    }
  }
  return process.env.KNOCK_SECRET_API_KEY || undefined;
}

// The port services use when no test injects one: the Knock adapter when the
// secret key is configured, the no-op adapter in keyless dev.
export function defaultNotificationsPort(): NotificationsPort {
  const secretKey = knockSecretKey();
  return secretKey ? knockNotifications(secretKey) : noopNotifications();
}

// Identifies a Cadence user to the notification vendor (name, email, avatar
// as the vendor's standard avatar property) so the feed always shows the
// current avatar, and writes the default preference set only if the user has
// none yet — the vendor's write replaces the whole set, so an existing set is
// never touched. Role is never synced. A failed sync is caught and logged:
// it must never fail the action around it.
export async function syncNotificationsUser(
  user: NotificationUser,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<void> {
  try {
    await port.identifyUser(user);
    const existing = await port.getPreferences(user.id);
    if (existing === null) {
      await port.setPreferences(user.id, DEFAULT_NOTIFICATION_PREFERENCES);
    }
  } catch (error) {
    console.error(`Notification sync failed for user ${user.id}:`, error);
  }
}
