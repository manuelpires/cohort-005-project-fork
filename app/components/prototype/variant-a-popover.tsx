// PROTOTYPE — Variant A of the Notification Feed UI prototype: a bell in the
// sidebar footer opening a compact popover. Not production code; lives on the
// prototype branch only.
//
// Placement answer: the feed is a glanceable popover anchored to the sidebar
// footer; opening it marks everything seen, clicking a row marks it read and
// navigates.
import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import { relativeTime, type useKnockFeed } from "./knock-feed";
import { notificationMeta } from "./catalogue";
import { MetaIcon } from "./meta-icon";

type Feed = ReturnType<typeof useKnockFeed>;

export function VariantAPopover({ feed }: { feed: Feed }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const seenOnOpen = useRef(false);

  useEffect(() => {
    if (!open) {
      seenOnOpen.current = false;
      return;
    }
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Opening the panel marks everything seen after a beat.
  useEffect(() => {
    if (!open || seenOnOpen.current) return;
    seenOnOpen.current = true;
    const timer = setTimeout(() => feed.markAllSeen(), 800);
    return () => clearTimeout(timer);
  }, [open, feed]);

  const unread = feed.unreadCount ?? 0;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        title="Notifications"
        className={cn(
          "relative rounded-md p-1.5 transition-colors",
          open
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed left-[14.5rem] top-[4.25rem] z-40 flex max-h-[28rem] w-[24rem] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">
              Notifications
              {unread > 0 && (
                <span className="ml-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                  {unread} unread
                </span>
              )}
            </span>
            <button
              onClick={() => feed.markAllRead()}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <CheckCheck className="size-3" />
              Mark all read
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {feed.entries.length === 0 && !feed.loading && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <CheckCheck className="size-6 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">You're all caught up.</p>
              </div>
            )}
            {feed.entries.map((entry) => {
              const meta = notificationMeta(entry);
              const actor = entry.actors?.[0];
              return (
                <a
                  key={entry.id}
                  href={meta.href}
                  onClick={() => {
                    if (!entry.read_at) feed.markRead(entry.id);
                  }}
                  className={cn(
                    "flex gap-2.5 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-accent/50",
                    !entry.read_at && "bg-primary/5"
                  )}
                >
                  {actor ? (
                    <UserAvatar
                      name={actor.name ?? "?"}
                      avatarUrl={actor.avatar_url ?? null}
                      className="size-7 shrink-0"
                    />
                  ) : (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
                      <MetaIcon meta={meta} className={cn("size-3.5", meta.tint)} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className={cn("truncate text-xs", !entry.read_at && "font-semibold")}>
                        {meta.title}
                      </p>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {relativeTime(entry.inserted_at)}
                      </span>
                    </div>
                    {meta.snippet && (
                      <p className="truncate text-[11px] text-muted-foreground">{meta.snippet}</p>
                    )}
                    {meta.context && (
                      <p className="truncate text-[10px] text-muted-foreground/70">
                        {meta.context}
                      </p>
                    )}
                  </div>
                  {!entry.read_at && (
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                  )}
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
