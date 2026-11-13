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

// Workflow keys are deterministic and identical in the vendor (see
// scripts/provision-knock-workflows.ts).
export type NotificationWorkflowKey =
  | "refund-request-raised"
  | "refund-request-open"
  | "refund-request-approved"
  | "refund-request-declined"
  | "discussion-question-created"
  | "discussion-reply-created"
  | "enrollment-created"
  | "seat-claimed";

// Which preference category each workflow belongs to. In Knock the category
// is tagged on the workflow itself and evaluated per recipient at delivery
// time; the fake below mirrors those semantics for tests.
export const WORKFLOW_CATEGORIES: Record<
  NotificationWorkflowKey,
  NotificationCategoryId
> = {
  "refund-request-raised": "refund-request-updates",
  "refund-request-open": "open-refund-requests",
  "refund-request-approved": "refund-request-updates",
  "refund-request-declined": "refund-request-updates",
  "discussion-question-created": "discussion-questions",
  "discussion-reply-created": "discussion-replies",
  "enrollment-created": "enrollments",
  "seat-claimed": "seat-claims",
};

export type NotificationTrigger = {
  workflow: NotificationWorkflowKey;
  /** The people the Notification concerns — never the actor themselves. */
  recipients: NotificationUser[];
  /** The person whose action caused the Notification, if there was one. */
  actor?: NotificationUser;
  /** Carried on the message; the feed renders from it. */
  data: Record<string, unknown>;
  /** One per domain event, so a retry layer added later cannot send duplicates. */
  idempotencyKey: string;
};

export interface NotificationsPort {
  identifyUser(user: NotificationUser): Promise<void>;
  getPreferences(userId: number): Promise<NotificationPreferences | null>;
  setPreferences(
    userId: number,
    preferences: NotificationPreferences
  ): Promise<void>;
  trigger(input: NotificationTrigger): Promise<void>;
  /** Archives every Notification a comment caused, removing it from feeds. */
  archiveCommentNotifications(commentId: number): Promise<void>;
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
  "refund-request-raised": "refund-request-raised",
  "refund-request-open": "refund-request-open",
  "refund-request-approved": "refund-request-approved",
  "refund-request-declined": "refund-request-declined",
  "discussion-question-created": "discussion-question-created",
  "discussion-reply-created": "discussion-reply-created",
  "enrollment-created": "enrollment-created",
  "seat-claimed": "seat-claimed",
};

// Inline identify: upserts the user, so a trigger never fails on a user the
// sync missed (name/email/avatar are the vendor's standard properties).
function knockRecipient(user: NotificationUser) {
  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    avatar: user.avatarUrl,
  };
}

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
        const channelSetting = setting.channel_types?.[
          KNOCK_FEED_CHANNEL_TYPE
        ];
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
          recipients: input.recipients.map(knockRecipient),
          actor: input.actor ? knockRecipient(input.actor) : null,
          data: input.data,
        },
        // The vendor dedupes on this header, so the per-domain-event key
        // makes retried triggers safe.
        { idempotencyKey: input.idempotencyKey }
      );
    },
    async archiveCommentNotifications(commentId) {
      // Verified against the dev environment: the trigger-data filter scopes
      // the listing to the messages this comment caused, across both
      // discussion workflows. Archived messages stay in the listing, so skip
      // the ones already archived.
      const messages = knock.messages.list({
        trigger_data: JSON.stringify({ commentId }),
      });
      for await (const message of messages) {
        if (message.archived_at === null) {
          await knock.messages.archive(message.id);
        }
      }
    },
  };
}

// ─── In-memory fake (tests) and no-op (keyless dev) ───

// One feed row per delivered recipient, mirroring what the vendor stores:
// the data snapshot from trigger time and whether the row has been archived
// out of the feed. Suppressed recipients never get a row.
export type FakeNotificationMessage = {
  id: string;
  workflow: NotificationWorkflowKey;
  recipientId: number;
  data: Record<string, unknown>;
  archivedAt: Date | null;
};

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
  readonly messages: FakeNotificationMessage[] = [];
  private nextMessageId = 1;

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

  async trigger(input: NotificationTrigger): Promise<void> {
    // Vendor semantics: each recipient's preference set is evaluated against
    // the workflow's category. A recipient with no set (never synced) gets
    // the workflow's default — delivery. "Off by default" for Enrollments is
    // written by Cadence's user sync, not by the vendor.
    const category = WORKFLOW_CATEGORIES[input.workflow];
    const deliveredTo: number[] = [];
    const suppressedFor: number[] = [];
    for (const recipient of input.recipients) {
      const muted =
        this.preferenceSets.get(recipient.id)?.[category] === false;
      if (muted) suppressedFor.push(recipient.id);
      else deliveredTo.push(recipient.id);
    }
    this.triggers.push({
      ...input,
      recipients: [...input.recipients],
      data: { ...input.data },
      deliveredTo,
      suppressedFor,
    });
    for (const recipientId of deliveredTo) {
      this.messages.push({
        id: `fake-message-${this.nextMessageId++}`,
        workflow: input.workflow,
        recipientId,
        data: { ...input.data },
        archivedAt: null,
      });
    }
  }

  async archiveCommentNotifications(commentId: number): Promise<void> {
    for (const message of this.messages) {
      if (
        message.data.commentId === commentId &&
        message.archivedAt === null
      ) {
        message.archivedAt = new Date();
      }
    }
  }

  /** What the recipient's feed shows: their unarchived Notifications. */
  messagesFor(recipientId: number): FakeNotificationMessage[] {
    return this.messages.filter(
      (message) =>
        message.recipientId === recipientId && message.archivedAt === null
    );
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
    async archiveCommentNotifications() {},
  };
}

// ─── Default selection, user sync and best-effort triggers ───

// Reads a Knock env value, loading .env first when needed: Vite doesn't put
// non-VITE_ vars on process.env. Shared with the feed config module.
// Tests never resolve live keys.
export function knockEnv(name: string): string | undefined {
  if (process.env.VITEST) return undefined;
  if (!process.env[name]) {
    try {
      // A missing .env just means keyless dev.
      process.loadEnvFile(".env");
    } catch {
      return undefined;
    }
  }
  return process.env[name] || undefined;
}

function knockSecretKey(): string | undefined {
  return knockEnv("KNOCK_SECRET_API_KEY");
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
      await port.setPreferences(
        user.id,
        DEFAULT_NOTIFICATION_PREFERENCES
      );
    }
  } catch (error) {
    console.error(`Notification sync failed for user ${user.id}:`, error);
  }
}

// Triggers are best-effort and run after the domain write commits: a vendor
// outage is caught and logged, never failing the domain action around it.
export async function triggerNotification(
  input: NotificationTrigger,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<void> {
  try {
    await port.trigger(input);
  } catch (error) {
    console.error(`Notification trigger failed (${input.workflow}):`, error);
  }
}

// Archiving is best-effort for the same reason as triggering.
export async function archiveCommentNotifications(
  commentId: number,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<void> {
  try {
    await port.archiveCommentNotifications(commentId);
  } catch (error) {
    console.error(
      `Notification archive failed for comment ${commentId}:`,
      error
    );
  }
}
