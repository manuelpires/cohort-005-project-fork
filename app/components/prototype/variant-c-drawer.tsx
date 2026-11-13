// PROTOTYPE — Variant C of the Notification Feed UI prototype: a bell beside
// the Cadence logo opening a rich slide-over drawer. Not production code;
// lives on the prototype branch only.
//
// Placement answer: the feed overlays the app from the right; room for rich
// rows grouped Today / Earlier. Opening marks seen; clicking a row marks it
// read and navigates.
import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { cn } from "~/lib/utils";
import { UserAvatar } from "~/components/user-avatar";
import { isToday, relativeTime, type useKnockFeed } from "./knock-feed";
import { notificationMeta } from "./catalogue";
import { MetaIcon } from "./meta-icon";

type Feed = ReturnType<typeof useKnockFeed>;

export function VariantCLeftBell({ feed, onOpen }: { feed: Feed; onOpen: () => void }) {
  const unread = feed.unreadCount ?? 0;
  return (
    <button
      onClick={onOpen}
      title="Notifications"
      className="relative rounded-md p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    >
      <Bell className="size-4.5" />
      {unread > 0 && (
        <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

export function VariantCDrawer({ feed, open, onClose }: { feed: Feed; open: boolean; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const seenOnOpen = useRef(false);

  useEffect(() => {
    if (open) {
      seenOnOpen.current = false;
      requestAnimationFrame(() => setMounted(true));
    } else {
      setMounted(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || mounted === false || seenOnOpen.current) return;
    if (!mounted) return;
    seenOnOpen.current = true;
    const timer = setTimeout(() => feed.markAllSeen(), 800);
    return () => clearTimeout(timer);
  }, [open, mounted, feed]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    if (open) document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const unread = feed.unreadCount ?? 0;
  const today = feed.entries.filter((entry) => isToday(entry.inserted_at));
  const earlier = feed.entries.filter((entry) => !isToday(entry.inserted_at));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className={cn(
          "absolute inset-0 bg-black/40 transition-opacity duration-200",
          mounted ? "opacity-100" : "opacity-0"
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "absolute right-0 top-0 flex h-full w-[26rem] max-w-full flex-col border-l bg-background shadow-xl transition-transform duration-200",
          mounted ? "translate-x-0" : "translate-x-full"
        )}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Notifications</h2>
            {unread > 0 && (
              <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                {unread} new
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => feed.markAllRead()}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {feed.entries.length === 0 && !feed.loading && (
            <div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
              <CheckCheck className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">You're all caught up.</p>
            </div>
          )}

          {([
            ["Today", today],
            ["Earlier", earlier],
          ] as const).map(([heading, entries]) =>
            entries.length > 0 ? (
              <div key={heading} className="mb-2">
                <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {heading}
                </p>
                {entries.map((entry) => {
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
                        "flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-accent/50",
                        !entry.read_at && "bg-primary/5"
                      )}
                    >
                      {actor ? (
                        <UserAvatar
                          name={actor.name ?? "?"}
                          avatarUrl={actor.avatar_url ?? null}
                          className="size-9 shrink-0"
                        />
                      ) : (
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                          <MetaIcon meta={meta} className={cn("size-4", meta.tint)} />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className={cn("text-sm", !entry.read_at ? "font-semibold" : "font-medium")}>
                            {meta.title}
                          </p>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {relativeTime(entry.inserted_at)}
                          </span>
                        </div>
                        {meta.snippet && (
                          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                            {meta.snippet}
                          </p>
                        )}
                        {meta.context && (
                          <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/80">
                            <MetaIcon meta={meta} className={cn("size-3", meta.tint)} />
                            {meta.context}
                          </p>
                        )}
                      </div>
                      {!entry.read_at && (
                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                      )}
                    </a>
                  );
                })}
              </div>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}
