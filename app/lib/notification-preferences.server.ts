import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { courses, coupons, purchases, users, UserRole } from "~/db/schema";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  defaultNotificationsPort,
  type NotificationCategoryId,
  type NotificationsPort,
} from "./notifications.server";

// ─── Notification preferences ───
// The server half of the Notifications card on /settings: which switches a
// person sees (what they are or have, never their role) and how one flip is
// merged into their preference set. The vendor's write replaces the whole
// set, so a flip reads the current set, merges the single change over the
// defaults, and writes the full set back. See GLOSSARY.md and PRD #53's
// "Preferences" section.

type Db = BetterSQLite3Database<typeof schema>;

export type NotificationPreferenceRow = {
  category: NotificationCategoryId;
  label: string;
  enabled: boolean;
};

// The card's fixed row order (PRD #53's "Preferences" table).
const ROW_ORDER: Array<{ category: NotificationCategoryId; label: string }> = [
  { category: "refund-request-updates", label: "Refund Request updates" },
  { category: "open-refund-requests", label: "Open Refund Requests" },
  { category: "seat-claims", label: "Seat claims" },
  { category: "enrollments", label: "Enrollments" },
  { category: "discussion-questions", label: "Discussion Questions" },
  { category: "discussion-replies", label: "Discussion Replies" },
];

// ─── What the person is or has ───
// Switch visibility is queried from the database, not taken from a role,
// and mirrors exactly who each workflow's recipients are: the buyer of a
// Purchase (refund-request-updates), the buyer of a Team Licence
// (seat-claims — the same resolution notifySeatClaimed uses), the owner of
// a course (enrollments, discussion-questions) and a Platform Admin
// (open-refund-requests). A hidden switch keeps its default and appears
// when the person later qualifies — the sync has already written the full
// default set, so there is nothing extra to do.

function hasPurchase(db: Db, userId: number) {
  return (
    db
      .select({ id: purchases.id })
      .from(purchases)
      .where(eq(purchases.userId, userId))
      .get() !== undefined
  );
}

function isTeamLicenceBuyer(db: Db, userId: number) {
  return (
    db
      .select({ id: coupons.id })
      .from(coupons)
      .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
      .where(eq(purchases.userId, userId))
      .get() !== undefined
  );
}

function ownsCourse(db: Db, userId: number) {
  return (
    db
      .select({ id: courses.id })
      .from(courses)
      .where(eq(courses.instructorId, userId))
      .get() !== undefined
  );
}

function isPlatformAdmin(db: Db, userId: number) {
  return (
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.role, UserRole.Admin)))
      .get() !== undefined
  );
}

// The switches the person sees, in the card's row order, each carrying the
// effective value: their stored set merged over the defaults. Hidden
// categories are simply left out — they keep whatever the sync wrote.
export async function getNotificationPreferenceRows(
  db: Db,
  userId: number,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<NotificationPreferenceRow[]> {
  const visible = new Set<NotificationCategoryId>(["discussion-replies"]);
  if (hasPurchase(db, userId)) visible.add("refund-request-updates");
  if (isTeamLicenceBuyer(db, userId)) visible.add("seat-claims");
  if (ownsCourse(db, userId)) {
    visible.add("enrollments");
    visible.add("discussion-questions");
  }
  if (isPlatformAdmin(db, userId)) visible.add("open-refund-requests");

  const stored = (await port.getPreferences(userId)) ?? {};
  const effective = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...stored,
  };

  return ROW_ORDER.filter((row) => visible.has(row.category)).map((row) => ({
    ...row,
    enabled: effective[row.category],
  }));
}

// Merges one change into the person's preference set and writes the full
// set back. Unlike the best-effort sync and triggers, a failing write
// propagates: the settings action turns it into the toast-and-revert the
// card shows.
export async function mergeNotificationPreference(
  userId: number,
  category: NotificationCategoryId,
  on: boolean,
  port: NotificationsPort = defaultNotificationsPort()
): Promise<void> {
  const stored = await port.getPreferences(userId);
  const merged = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(stored ?? {}),
    [category]: on,
  };
  await port.setPreferences(userId, merged);
}
