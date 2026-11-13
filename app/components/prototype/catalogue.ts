// PROTOTYPE — throwaway catalogue meta for the Notification Feed UI
// prototype. Not production code; lives on the prototype branch only.
//
// Maps a Knock workflow key (entry.source.key) to the display strings a
// Notification row needs. Cadence renders rows itself from actors + data;
// the vendor template only carries the action URL fallback.
import type { FeedEntry, KnockActor } from "./knock-feed";

export interface NotificationMeta {
  label: string;
  title: string;
  snippet: string | null;
  context: string | null;
  href: string;
  icon: "message" | "cap" | "receipt" | "users";
  tint: string;
}

function str(entry: FeedEntry, key: string): string {
  const value = entry.data?.[key];
  return typeof value === "string" ? value : "";
}

function actorName(entry: FeedEntry): string {
  const first: KnockActor | undefined = entry.actors?.[0];
  return first?.name ?? "Someone";
}

export function notificationMeta(entry: FeedEntry): NotificationMeta {
  const key = entry.source?.key ?? "";
  const actor = actorName(entry);
  switch (key) {
    case "discussion-reply": {
      return {
        label: "Discussion Reply",
        title: `${actor} replied to your question`,
        snippet: str(entry, "reply_snippet") || null,
        context: str(entry, "lesson_title") || null,
        href: str(entry, "lesson_url") || "/courses",
        icon: "message",
        tint: "text-sky-600 dark:text-sky-400",
      };
    }
    case "discussion-question": {
      return {
        label: "Discussion Question",
        title: `${actor} asked a question`,
        snippet: str(entry, "question_snippet") || null,
        context: str(entry, "lesson_title") || null,
        href: str(entry, "lesson_url") || "/courses",
        icon: "message",
        tint: "text-sky-600 dark:text-sky-400",
      };
    }
    case "new-enrollment": {
      return {
        label: "New Enrollment",
        title: `${actor} enrolled on your course`,
        snippet: null,
        context: str(entry, "course_title") || null,
        href: "/instructor",
        icon: "cap",
        tint: "text-violet-600 dark:text-violet-400",
      };
    }
    case "refund-request-approved": {
      const amount = str(entry, "refund_amount");
      return {
        label: "Refund Approved",
        title: "Your refund was approved",
        snippet: amount ? `$${amount} back to your payment method.` : null,
        context: str(entry, "course_title") || null,
        href: "/settings",
        icon: "receipt",
        tint: "text-emerald-600 dark:text-emerald-400",
      };
    }
    case "claimed-seat": {
      return {
        label: "Claimed Seat",
        title: `${actor} claimed a seat on your team`,
        snippet: null,
        context: str(entry, "course_title") || null,
        href: "/team",
        icon: "users",
        tint: "text-amber-600 dark:text-amber-400",
      };
    }
    default: {
      return {
        label: key || "Notification",
        title: entry.blocks?.[0]?.rendered ?? "Notification",
        snippet: null,
        context: null,
        href: entry.blocks?.[0]?.action_url ?? "/",
        icon: "message",
        tint: "text-muted-foreground",
      };
    }
  }
}
