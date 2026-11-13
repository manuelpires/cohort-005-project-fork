// PROTOTYPE — Variant B of the Notification Feed UI prototype: the
// Notification Feed as a dedicated page reached from a sidebar nav item. Not
// production code; lives on the prototype branch only.
//
// Placement answer: a "Notifications" nav item with a badge; the page gives
// the feed room — All/Unread tabs, roomy rows, explicit bulk actions.
import { useState } from "react";
import { Bell, CheckCheck, MailOpen } from "lucide-react";
import { cn } from "~/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { UserAvatar } from "~/components/user-avatar";
import { relativeTime, type useKnockFeed } from "./knock-feed";
import { notificationMeta } from "./catalogue";
import { MetaIcon } from "./meta-icon";

type Feed = ReturnType<typeof useKnockFeed>;

export function VariantBPage({ feed }: { feed: Feed }) {
  const [tab, setTab] = useState<"all" | "unread">("all");
  const unread = feed.unreadCount ?? 0;
  const entries =
    tab === "unread" ? feed.entries.filter((entry) => !entry.read_at) : feed.entries;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {unread > 0
              ? `${unread} unread Notification${unread === 1 ? "" : "s"}`
              : "You're all caught up."}
          </p>
        </div>
        <button
          onClick={() => feed.markAllRead()}
          disabled={unread === 0}
          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:opacity-40"
        >
          <CheckCheck className="size-4" />
          Mark all read
        </button>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as "all" | "unread")}>
        <TabsList className="mb-4">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unread">Unread{unread > 0 ? ` (${unread})` : ""}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="divide-y rounded-lg border">
        {entries.length === 0 && (
          <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
            <Bell className="size-8 text-muted-foreground/40" />
            <div>
              <p className="font-medium">
                {tab === "unread" ? "Nothing unread" : "No Notifications yet"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tab === "unread"
                  ? "Unread Notifications will show up here."
                  : "Fire some from the prototype bar below to see them land."}
              </p>
            </div>
          </div>
        )}

        {entries.map((entry) => {
          const meta = notificationMeta(entry);
          const actor = entry.actors?.[0];
          return (
            <div
              key={entry.id}
              className={cn("group relative flex gap-4 px-5 py-4", !entry.read_at && "bg-primary/5")}
            >
              {actor ? (
                <UserAvatar
                  name={actor.name ?? "?"}
                  avatarUrl={actor.avatar_url ?? null}
                  className="size-10 shrink-0"
                />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                  <MetaIcon meta={meta} className={cn("size-5", meta.tint)} />
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <p className={cn("text-sm", !entry.read_at ? "font-semibold" : "font-medium")}>
                    {meta.title}
                  </p>
                  <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                    {relativeTime(entry.inserted_at)}
                  </span>
                </div>
                {meta.snippet && (
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                    {meta.snippet}
                  </p>
                )}
                {meta.context && (
                  <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                    <MetaIcon meta={meta} className={cn("size-3", meta.tint)} />
                    {meta.context}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {!entry.read_at ? (
                  <a
                    href={meta.href}
                    onClick={() => feed.markRead(entry.id)}
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    View
                  </a>
                ) : (
                  <button
                    onClick={() => feed.markUnread(entry.id)}
                    title="Mark unread"
                    className="rounded-md border p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                  >
                    <MailOpen className="size-3.5" />
                  </button>
                )}
                {!entry.read_at && <span className="size-2 rounded-full bg-primary" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
