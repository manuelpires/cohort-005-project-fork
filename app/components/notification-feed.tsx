import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useNavigate } from "react-router";
import {
  Bell,
  Check,
  GraduationCap,
  MessageSquare,
  Receipt,
  Settings,
  UsersRound,
} from "lucide-react";
import { UserAvatar } from "~/components/user-avatar";
import { cn, formatRelativeTime } from "~/lib/utils";
import {
  NotificationFeedStore,
  describeNotification,
  emptyNotificationFeedClient,
  knockNotificationFeedClient,
  notificationClickAction,
  unseenBadgeLabel,
  type NotificationCategory,
  type NotificationFeedClientConfig,
  type NotificationFeedItem,
  type NotificationFeedState,
} from "~/lib/notifications-feed";

// The Notification Feed UI: a bell in the sidebar header with a red badge
// counting unseen Notifications, opening a popover beside the sidebar. The
// accepted prototype variant (7f0e368) — one chronological list, infinite
// scroll, ✓ marks read — rebuilt on the Cadence-owned client port in
// ~/lib/notifications-feed. No markup tests: this repo has no
// component-test prior art; the port seam carries the logic tests.

const FeedContext = createContext<NotificationFeedStore | null>(null);

export function useNotificationFeed(): NotificationFeedStore | null {
  return useContext(FeedContext);
}

export function NotificationFeedProvider({
  config,
  children,
}: {
  config: NotificationFeedClientConfig | null;
  children: React.ReactNode;
}) {
  const store = useMemo(
    // A null config (keyless dev) still gets a store over the empty
    // adapter, so the feed shows its empty state; the sidebar only mounts
    // the bell for signed-in users, so signed-out never sees it.
    () =>
      new NotificationFeedStore(
        config ? knockNotificationFeedClient(config) : emptyNotificationFeedClient()
      ),
    [config]
  );

  useEffect(() => () => store.teardown(), [store]);

  return <FeedContext.Provider value={store}>{children}</FeedContext.Provider>;
}

const EMPTY_STATE: NotificationFeedState = {
  items: [],
  unseen: 0,
  unread: 0,
  hasMore: false,
  loadingMore: false,
  initialized: false,
};

function useFeedState(feed: NotificationFeedStore | null) {
  // The server snapshot matches the initial client snapshot (empty,
  // uninitialized): the store only changes inside client effects, so
  // hydration never mismatches.
  const snapshot = () => feed?.getState() ?? EMPTY_STATE;
  return useSyncExternalStore(
    (listener) => feed?.subscribe(listener) ?? (() => {}),
    snapshot,
    snapshot
  );
}

export function NotificationBell() {
  const feed = useNotificationFeed();
  const [open, setOpen] = useState(false);
  const state = useFeedState(feed);
  const badge = unseenBadgeLabel(state.unseen);

  useEffect(() => {
    if (feed) void feed.refresh();
  }, [feed]);

  function toggle() {
    const next = !open;
    setOpen(next);
    // Opening marks everything seen — bulk, covering unloaded history —
    // and clears the badge, without marking anything read: seen ≠ read.
    if (next) void feed?.markAllSeen();
  }

  if (!feed) return null;

  return (
    <>
      <button
        onClick={toggle}
        title="Notifications"
        aria-label="Notifications"
        className="relative rounded-md p-1.5 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Bell className="size-4" />
        {badge && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <NotificationPopover feed={feed} close={() => setOpen(false)} />
        </>
      )}
    </>
  );
}

function NotificationPopover({
  feed,
  close,
}: {
  feed: NotificationFeedStore;
  close: () => void;
}) {
  const state = useFeedState(feed);
  const navigate = useNavigate();
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // The sentinel sits at the list's end; store.loadMore() no-ops while a
    // page is in flight or the history is exhausted, so repeated
    // intersections are safe.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void feed.loadMore();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [feed]);

  function openItem(item: NotificationFeedItem) {
    const action = notificationClickAction(item);
    if (action.markRead) void feed.markRead(item.id);
    // Nowhere to go (the Refund Request confirmation): stay put.
    if (action.url === null) return;
    close();
    navigate(action.url);
  }

  return (
    <div className="fixed left-56 top-2 z-50 ml-2 flex max-h-[calc(100vh-1rem)] w-[26rem] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl">
      <div className="flex items-center gap-2 bg-muted/60 px-4 py-3">
        <Bell className="size-4" />
        <span className="font-semibold">Notifications</span>
        {/* The Notifications preference card (#61) lands on /settings. */}
        <Link
          to="/settings"
          title="Notification settings"
          onClick={close}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Settings className="size-4" />
        </Link>
        <button
          onClick={() => void feed.markAllRead()}
          disabled={state.unread === 0}
          className="text-xs font-medium text-primary hover:underline disabled:opacity-40 disabled:hover:no-underline"
        >
          Mark all as read
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {state.items.map((item) => (
          <NotificationRow
            key={item.id}
            item={item}
            feed={feed}
            onOpen={openItem}
          />
        ))}
        {state.items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {state.initialized ? "You're all caught up." : "Loading…"}
          </p>
        )}
        <div
          ref={sentinelRef}
          className="p-3 text-center text-xs text-muted-foreground"
        >
          {state.loadingMore
            ? "Loading…"
            : !state.hasMore && state.items.length > 0 && "That's everything."}
        </div>
      </div>
    </div>
  );
}

const categoryIcon: Record<NotificationCategory, React.ReactNode> = {
  discussion: <MessageSquare className="size-4" />,
  refund: <Receipt className="size-4" />,
  team: <UsersRound className="size-4" />,
  enrollment: <GraduationCap className="size-4" />,
};

function NotificationRow({
  item,
  feed,
  onOpen,
}: {
  item: NotificationFeedItem;
  feed: NotificationFeedStore;
  onOpen: (item: NotificationFeedItem) => void;
}) {
  const summary = describeNotification(item);
  const unread = item.readAt === null;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent">
      <span className="relative shrink-0">
        {item.actor ? (
          <UserAvatar
            name={item.actor.name}
            avatarUrl={item.actor.avatarUrl}
            className={cn("size-9", !unread && "opacity-60")}
          />
        ) : (
          // From Cadence itself (the Refund Request confirmation).
          <span
            className={cn(
              "flex size-9 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground",
              !unread && "opacity-60"
            )}
          >
            C
          </span>
        )}
        <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-popover text-muted-foreground ring-1 ring-border [&_svg]:size-2.5">
          {categoryIcon[summary.category]}
        </span>
      </span>
      <button onClick={() => onOpen(item)} className="min-w-0 flex-1 text-left">
        <span className={cn("block truncate text-sm", unread && "font-semibold")}>
          {summary.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[summary.snippet, formatRelativeTime(item.insertedAt)]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </button>
      {unread && (
        <button
          onClick={() => void feed.markRead(item.id)}
          title="Mark as read"
          className="shrink-0 rounded-full p-1 text-muted-foreground hover:bg-background hover:text-primary"
        >
          <Check className="size-4" />
        </button>
      )}
    </div>
  );
}
