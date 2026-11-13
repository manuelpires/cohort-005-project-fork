// ─── Notification feed client port ───
// The browser half of the notification vendor boundary: everything the feed
// UI needs — listing the feed (cursor-paginated), unseen/unread counts,
// marking seen/read singly and in bulk, live updates, and the connection
// lifecycle. The Knock adapter below is the only code that speaks the
// vendor's REST and real-time socket shapes from the browser (public key
// plus per-user signed token). Keyless dev falls back to the empty adapter
// so the feed shows its empty state, the way the app runs without a
// Postmark token. Tests inject the fake and assert on what it recorded —
// nothing here touches the network under test.
//
// Deliberately not named "*.client.ts": React Router's Vite plugin stubs
// every export of a .client module to undefined during SSR, and the store
// server-renders inside the layout. The module is browser-first but
// SSR-safe — fetches only ever start from client effects.

export type NotificationFeedActor = {
  name: string;
  avatarUrl: string | null;
};

export type NotificationFeedItem = {
  id: string;
  /** The workflow that caused the Notification, e.g. "discussion-reply-created". */
  workflow: string;
  /** ISO timestamp of delivery. */
  insertedAt: string;
  readAt: string | null;
  seenAt: string | null;
  /** Who caused the Notification; null when it comes from Cadence itself. */
  actor: NotificationFeedActor | null;
  /** The trigger's data snapshot — rows render from it exactly as delivered. */
  data: Record<string, unknown>;
};

export type NotificationFeedCounts = {
  unseen: number;
  unread: number;
};

export type NotificationFeedPage = NotificationFeedCounts & {
  items: NotificationFeedItem[];
  /** Cursor for the next older page; null when the history is exhausted. */
  cursor: string | null;
};

export interface NotificationFeedClient {
  /** One newest-first page of history; pass the previous page's cursor. */
  list(cursor?: string): Promise<NotificationFeedPage>;
  counts(): Promise<NotificationFeedCounts>;
  markSeen(ids: string[]): Promise<void>;
  markRead(ids: string[]): Promise<void>;
  /** Bulk by channel — covers Notifications that have not loaded. */
  markAllSeen(): Promise<void>;
  markAllRead(): Promise<void>;
  /**
   * Live updates: the listener fires whenever the feed may have changed, so
   * consumers re-read page one. The Knock adapter backs this with its
   * real-time socket on the user's feed topic; the empty adapter (keyless
   * dev) never fires it. Returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
  /** Releases the connection and any live subscription. */
  teardown(): void;
}

/** The red badge's label: hidden while nothing is unseen, capped at "9+". */
export function unseenBadgeLabel(unseen: number): string | null {
  if (unseen <= 0) return null;
  return unseen > 9 ? "9+" : String(unseen);
}

export type NotificationClickAction = {
  /** Clicking always deals with an unread Notification… */
  markRead: boolean;
  /** …and navigates when there is somewhere specific to go. */
  url: string | null;
};

// Clicking a row goes to the most specific place — a Discussion Question or
// Reply lands on the comment anchor itself. A Notification with nowhere to
// go (the Refund Request confirmation) only marks itself read, and the
// popover stays open.
export function notificationClickAction(
  item: NotificationFeedItem
): NotificationClickAction {
  const url = item.data.url;
  return {
    markRead: item.readAt === null,
    url: typeof url === "string" && url.length > 0 ? url : null,
  };
}

// ─── Row copy ───
// Written by Cadence from the trigger data snapshot, not by vendor
// templates. The shapes below are exactly what the workflow triggers send
// (see the trigger call sites for each payload).

export type NotificationCategory =
  | "discussion"
  | "refund"
  | "team"
  | "enrollment";

export type NotificationSummary = {
  category: NotificationCategory;
  title: string;
  snippet: string | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function quoted(value: string | null): string | null {
  return value === null ? null : `“${value}”`;
}

// The actor comes back on the feed entry; the fallbacks cover entries the
// user sync missed, where the trigger data still carries the name.
function actorName(item: NotificationFeedItem): string {
  if (item.actor?.name) return item.actor.name;
  return (
    text(item.data.buyerName) ??
    text(item.data.studentName) ??
    text(item.data.claimerName) ??
    "Someone"
  );
}

export function describeNotification(
  item: NotificationFeedItem
): NotificationSummary {
  const actor = actorName(item);
  const data = item.data;
  switch (data.kind) {
    case "discussion-question":
      return {
        category: "discussion",
        title: `${actor} asked a question`,
        snippet: quoted(text(data.snippet)),
      };
    case "discussion-reply":
      return {
        category: "discussion",
        title: `${actor} replied to your question`,
        snippet: quoted(text(data.snippet)),
      };
    case "open-refund-request":
      return {
        category: "refund",
        title: `${actor} requested a ${data.amount} refund`,
        snippet: quoted(text(data.reason)),
      };
    case "refund-request-approved":
      return {
        category: "refund",
        title: "Your Refund Request was approved",
        snippet: quoted(text(data.decisionNote)),
      };
    case "refund-request-declined":
      return {
        category: "refund",
        title: "Your Refund Request was declined",
        snippet: `${quoted(text(data.decisionNote)) ?? ""} You can ask again.`.trim(),
      };
    case "refund-request-confirmed":
      return {
        category: "refund",
        title: "We've received your Refund Request",
        snippet: "A Platform Admin will review it.",
      };
  }
  // The growth triggers carry no data.kind — their workflows differ.
  if (item.workflow === "enrollment-created") {
    return {
      category: "enrollment",
      title: `${actor} enrolled in ${data.courseTitle ?? "your course"}`,
      snippet: null,
    };
  }
  if (item.workflow === "seat-claimed") {
    return {
      category: "team",
      title: `${actor} claimed a Seat`,
      snippet: `${data.seatsLeft} Seats left`,
    };
  }
  return { category: "discussion", title: "New notification", snippet: null };
}

// ─── In-memory fake (tests) ───
// The vendor as the store sees it: full newest-first history with per-item
// seen/read state, opaque string cursors, and counts derived from the items
// — so seen-≠-read and bulk-covers-unloaded semantics are real behaviour
// here, not stubs. What it recorded is assertable through `calls`.

export class FakeNotificationFeed implements NotificationFeedClient {
  /** Full history, newest first — the vendor's source of truth. */
  readonly items: NotificationFeedItem[];
  /** One entry per port call, e.g. "list:first", "list:3", "markAllSeen". */
  readonly calls: string[] = [];
  pageSize: number;
  /** Awaited inside list() to simulate a page that is slow to arrive. */
  gate: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(items: NotificationFeedItem[] = [], pageSize = 3) {
    this.items = [...items];
    this.pageSize = pageSize;
  }

  private countsFromState(): NotificationFeedCounts {
    return {
      unseen: this.items.filter((item) => item.seenAt === null).length,
      unread: this.items.filter((item) => item.readAt === null).length,
    };
  }

  private stamp(ids: string[], field: "seenAt" | "readAt") {
    const now = new Date().toISOString();
    const wanted = new Set(ids);
    for (const item of this.items) {
      if (wanted.has(item.id) && item[field] === null) {
        item[field] = now;
      }
    }
  }

  async list(cursor?: string): Promise<NotificationFeedPage> {
    this.calls.push(`list:${cursor ?? "first"}`);
    if (this.gate) await this.gate;
    const start = cursor ? Number(cursor) : 0;
    return {
      items: this.items
        .slice(start, start + this.pageSize)
        .map((item) => ({ ...item })),
      cursor:
        start + this.pageSize < this.items.length
          ? String(start + this.pageSize)
          : null,
      ...this.countsFromState(),
    };
  }

  async counts(): Promise<NotificationFeedCounts> {
    this.calls.push("counts");
    return this.countsFromState();
  }

  async markSeen(ids: string[]): Promise<void> {
    this.calls.push(`markSeen:${ids.length}`);
    this.stamp(ids, "seenAt");
  }

  async markRead(ids: string[]): Promise<void> {
    this.calls.push(`markRead:${ids.length}`);
    this.stamp(ids, "readAt");
  }

  async markAllSeen(): Promise<void> {
    this.calls.push("markAllSeen");
    const now = new Date().toISOString();
    for (const item of this.items) {
      if (item.seenAt === null) item.seenAt = now;
    }
  }

  async markAllRead(): Promise<void> {
    this.calls.push("markAllRead");
    const now = new Date().toISOString();
    for (const item of this.items) {
      if (item.readAt === null) item.readAt = now;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What the adapter's live socket does on a feed event. */
  emitChange(): void {
    for (const listener of this.listeners) listener();
  }

  teardown(): void {
    this.calls.push("teardown");
  }
}

export function fakeNotificationFeed(
  items: NotificationFeedItem[] = [],
  pageSize = 3
): FakeNotificationFeed {
  return new FakeNotificationFeed(items, pageSize);
}

// ─── The feed state the UI renders ───
// Framework-agnostic on purpose: the React layer subscribes to it, tests
// drive it directly, and no polling exists anywhere — the only re-reads are
// the mount refresh, scrolling deeper, and the adapter's live callback.

export type NotificationFeedState = {
  /** Everything loaded so far, newest first. */
  items: NotificationFeedItem[];
  unseen: number;
  unread: number;
  /** Whether older history remains beyond the loaded pages. */
  hasMore: boolean;
  loadingMore: boolean;
  /** Whether the first page read has finished (or failed best-effort). */
  initialized: boolean;
};

export class NotificationFeedStore {
  private client: NotificationFeedClient;
  private byId = new Map<string, NotificationFeedItem>();
  // undefined = never loaded, null = no more pages.
  private cursor: string | null | undefined = undefined;
  private unseen = 0;
  private unread = 0;
  private loadingMore = false;
  private initialized = false;
  // Coalescing state for refresh(): a read already in flight absorbs any
  // refreshes requested meanwhile into one trailing read.
  private refreshing = false;
  private refreshQueued = false;
  private listeners = new Set<() => void>();
  private state: NotificationFeedState;
  private unsubscribeClient: () => void;

  constructor(client: NotificationFeedClient) {
    this.client = client;
    this.state = this.computeState();
    // The adapter's live socket fires whenever the feed may have changed;
    // the coalescing refresh re-reads page one, so the socket drives the
    // badge and the open popover with no consumer changes.
    this.unsubscribeClient = client.subscribe(() => void this.refresh());
  }

  getState = (): NotificationFeedState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private computeState(): NotificationFeedState {
    return {
      items: [...this.byId.values()].sort((a, b) =>
        b.insertedAt.localeCompare(a.insertedAt)
      ),
      unseen: this.unseen,
      unread: this.unread,
      hasMore: this.cursor !== null && this.cursor !== undefined,
      loadingMore: this.loadingMore,
      initialized: this.initialized,
    };
  }

  private emit() {
    this.state = this.computeState();
    for (const listener of this.listeners) listener();
  }

  private patch(id: string, changes: Partial<NotificationFeedItem>) {
    const item = this.byId.get(id);
    if (item) this.byId.set(id, { ...item, ...changes });
  }

  private async readPage(cursor?: string): Promise<NotificationFeedPage> {
    const page = await this.client.list(cursor);
    for (const item of page.items) this.byId.set(item.id, item);
    this.unseen = page.unseen;
    this.unread = page.unread;
    return page;
  }

  /** Re-reads page one plus counts — the mount load and the live refresh.
   * A read already in flight absorbs further refreshes into a single
   * trailing read, so a burst of socket callbacks (the vendor throttles
   * its events, but not to one) never becomes a burst of feed reads —
   * the rate limit bites around 10 rapid reads. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const page = await this.readPage();
      // The stored cursor stays where scrolling left it: page one's cursor
      // only matters before anything has scrolled deeper, so a refresh
      // never rewinds the history the user has paged into.
      if (this.cursor === undefined) this.cursor = page.cursor;
    } catch (error) {
      console.error("Notification feed refresh failed:", error);
    } finally {
      this.refreshing = false;
      this.initialized = true;
      this.emit();
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  /** Loads the next older page for infinite scroll. */
  async loadMore(): Promise<void> {
    // The sentinel fires repeatedly while it stays visible, and a second
    // call while a page is in flight would fetch the same cursor twice.
    if (this.cursor == null || this.loadingMore) return;
    this.loadingMore = true;
    this.emit();
    try {
      const page = await this.readPage(this.cursor);
      this.cursor = page.cursor;
    } catch (error) {
      console.error("Notification feed page load failed:", error);
    } finally {
      this.loadingMore = false;
      this.emit();
    }
  }

  /** The ✓ and the row click: one Notification becomes dealt with. */
  async markRead(id: string): Promise<void> {
    const item = this.byId.get(id);
    if (!item || item.readAt !== null) return;
    this.patch(id, { readAt: new Date().toISOString() });
    this.unread = Math.max(0, this.unread - 1);
    this.emit();
    try {
      await this.client.markRead([id]);
    } catch (error) {
      console.error("Notification mark-read failed:", error);
    }
  }

  /** Opening the popover: everything becomes seen (bulk) but nothing read. */
  async markAllSeen(): Promise<void> {
    const now = new Date().toISOString();
    for (const item of this.byId.values()) {
      if (item.seenAt === null) this.patch(item.id, { seenAt: now });
    }
    this.unseen = 0;
    this.emit();
    try {
      await this.client.markAllSeen();
    } catch (error) {
      console.error("Notification mark-all-seen failed:", error);
    }
  }

  /** "Mark all as read": bulk by channel, covering unloaded history. */
  async markAllRead(): Promise<void> {
    const now = new Date().toISOString();
    for (const item of this.byId.values()) {
      if (item.readAt === null) this.patch(item.id, { readAt: now });
    }
    this.unread = 0;
    this.emit();
    try {
      await this.client.markAllRead();
    } catch (error) {
      console.error("Notification mark-all-read failed:", error);
    }
  }

  teardown(): void {
    this.unsubscribeClient();
    this.listeners.clear();
    this.client.teardown();
  }
}

// ─── Knock adapter (browser) ───
// The only code that speaks the vendor's REST shapes from the browser: the
// public key plus the per-user signed token from the layout loader. The
// vendor rejects (403) a token on anyone else's feed. Untested by design —
// tests assert on the fake above, the way the server-side Knock adapter is
// never exercised in vitest. Vendor gotchas baked in: an empty batch is a
// 422, per-user mark-all only covers loaded items (hence the bulk-by-channel
// endpoint), and pagination is cursor-based with a page-size cap of 100.

export type NotificationFeedClientConfig = {
  knockUserId: string;
  userToken: string;
  publicApiKey: string;
  feedChannelId: string;
};

const KNOCK_API = "https://api.knock.app/v1";
const PAGE_SIZE = 20;

// ─── Real-time socket (the adapter's live half) ───
// The vendor's realtime service speaks the Phoenix channel protocol
// (vsn 2.0.0) over a WebSocket whose URL must be fetched first: POST
// /v1/sockets/connect with the public key + user token returns a signed
// wss:// URL. This is a hand-rolled minimal client for the one topic the
// feed needs — the same wire protocol their browser SDK drives — so no
// vendor package joins the dependency tree. Like the REST half, it is
// untested by design: the transport is vendor-side; the port seam (via the
// fake) specifies everything observable.
//
// Frame shape: [join_ref, ref, topic, event, payload] as JSON, with
// control events phx_join / phx_leave / phx_reply — underscores on the
// wire, unlike the client-side constants in Phoenix's own docs. Refs are
// per-connection counting numbers as strings. The socket heartbeats every
// 30s on the "phoenix" topic; an unanswered heartbeat means the connection
// is dead, and it is re-established with backoff — except on an auth
// rejection (a stale token only a page reload can re-sign), where retrying
// would never heal.

const PHOENIX_VSN = "2.0.0";
const HEARTBEAT_INTERVAL_MS = 30_000;
const JOIN_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SOCKET_TOPIC = "feeds:{feedChannelId}:{knockUserId}";

type PhoenixFrame = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

type KnockSocketConnectResponse = {
  url?: unknown;
  mode?: unknown;
};

function appendQueryString(url: string, queryString: string): string {
  return queryString
    ? `${url}${url.includes("?") ? "&" : "?"}${queryString}`
    : url;
}

function reconnectDelay(attempt: number): number {
  const cap = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  // Full jitter, so many clients never retry in lockstep.
  return Math.round(cap * Math.random());
}

function openKnockFeedSocket(
  config: NotificationFeedClientConfig,
  onFeedEvent: () => void
): { close: () => void } {
  const topic = SOCKET_TOPIC.replace("{feedChannelId}", config.feedChannelId)
    .replace("{knockUserId}", config.knockUserId);
  // The vendor addresses events to per-client reference ids (the "attn"
  // field); with one feed client per socket any event on the topic is ours,
  // but the join still names one so the server accepts it.
  const clientReferenceId = `client_${Math.random().toString(36).slice(2)}`;

  let closed = false;
  let socket: WebSocket | null = null;
  let nextRef = 0;
  let joinRef: string | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingHeartbeatRef: string | null = null;
  let joinTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function makeRef(): string {
    nextRef += 1;
    return String(nextRef);
  }

  function send(frame: PhoenixFrame): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    pendingHeartbeatRef = null;
  }

  function scheduleHeartbeat(): void {
    heartbeatTimer = setTimeout(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function sendHeartbeat(): void {
    if (pendingHeartbeatRef !== null) {
      // The last heartbeat went unanswered within its window: the
      // connection is dead even though the browser has not noticed. Drop
      // it so the reconnect path runs.
      socket?.close();
      return;
    }
    pendingHeartbeatRef = makeRef();
    send([null, pendingHeartbeatRef, "phoenix", "heartbeat", {}]);
    scheduleHeartbeat();
  }

  function handleFrame(raw: string): void {
    let frame: PhoenixFrame;
    try {
      frame = JSON.parse(raw) as PhoenixFrame;
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length < 5) return;
    const [frameJoinRef, , frameTopic, event, payload] = frame;

    if (event === "phx_reply") {
      const reply = payload as { status?: string } | null;
      // Any reply on the phoenix topic answers the one outstanding
      // heartbeat (the matching ref rides the frame, not the payload).
      if (frameTopic === "phoenix") pendingHeartbeatRef = null;
      if (frameTopic === topic) {
        if (joinTimeoutTimer !== null) clearTimeout(joinTimeoutTimer);
        joinTimeoutTimer = null;
        if (reply?.status === "error" && !closed) {
          // The join itself was rejected — an auth or channel problem, not
          // a blip. Only a page reload re-signs the token, so stop here;
          // feed reads still work over REST.
          console.error("Knock feed channel join was rejected:", reply);
          close();
        }
      }
      return;
    }

    // Today the vendor sends "new-message" on the feed topic; any other
    // feed-topic event would be a status change, and the listener's
    // re-read covers both without distinguishing them. As in Phoenix's
    // own dispatch, a frame carrying a foreign join ref is outdated
    // chatter from before a rejoin and is dropped.
    if (frameTopic === topic && (!frameJoinRef || frameJoinRef === joinRef)) {
      onFeedEvent();
    }
  }

  function joinFeedTopic(): void {
    joinRef = makeRef();
    reconnectAttempt = 0;
    send([
      joinRef,
      makeRef(),
      topic,
      "phx_join",
      // The query params the vendor's own feed clients join with; the
      // server needs at least one keyed client entry to accept the join.
      { [clientReferenceId]: { archived: "exclude", mode: "compact" } },
    ]);
    // As in Phoenix, a join that hears nothing back within its window is
    // treated as failed: drop the connection so the reconnect path re-joins.
    joinTimeoutTimer = setTimeout(() => {
      joinTimeoutTimer = null;
      socket?.close();
    }, JOIN_TIMEOUT_MS);
    scheduleHeartbeat();
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const attempt = reconnectAttempt;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => void connect(), reconnectDelay(attempt));
  }

  async function connect(): Promise<void> {
    let signedUrl: string;
    try {
      const response = await fetch(`${KNOCK_API}/sockets/connect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.publicApiKey}`,
          "X-Knock-User-Token": config.userToken,
        },
      });
      const body = (await response.json().catch(() => null)) as
        | KnockSocketConnectResponse
        | null;
      if (response.status === 401 || response.status === 403) {
        // The signed token was rejected. It cannot become valid again
        // without the layout loader re-signing it (a page reload — the
        // DevUI switcher always does one), so do not retry.
        console.error(
          `Knock socket connect rejected (${response.status}); giving up on live updates`
        );
        return;
      }
      if (!response.ok || body?.mode !== "websocket" || typeof body.url !== "string") {
        throw new Error(`Unexpected socket connect response (${response.status})`);
      }
      signedUrl = body.url;
    } catch (error) {
      if (!closed) {
        console.error("Knock socket connect failed:", error);
        scheduleReconnect();
      }
      return;
    }
    if (closed) return;

    const query = new URLSearchParams({
      vsn: PHOENIX_VSN,
      api_key: config.publicApiKey,
      user_token: config.userToken,
    });
    socket = new WebSocket(appendQueryString(signedUrl, query.toString()));
    socket.onopen = joinFeedTopic;
    socket.onmessage = (event) => {
      if (typeof event.data === "string") handleFrame(event.data);
    };
    socket.onclose = () => {
      stopHeartbeat();
      joinRef = null;
      socket = null;
      scheduleReconnect();
    };
  }

  function close(): void {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    stopHeartbeat();
    if (joinTimeoutTimer !== null) clearTimeout(joinTimeoutTimer);
    joinTimeoutTimer = null;
    if (socket) {
      const deadSocket = socket;
      socket = null;
      deadSocket.onclose = null;
      if (joinRef !== null) {
        try {
          deadSocket.send(
            JSON.stringify([joinRef, makeRef(), topic, "phx_leave", {}])
          );
        } catch {
          // The socket was already closing — nothing to leave.
        }
      }
      deadSocket.close();
    }
  }

  void connect();
  return { close };
}

type KnockFeedEntry = {
  id: string;
  inserted_at: string;
  read_at?: string | null;
  seen_at?: string | null;
  source?: { key?: string };
  actors?: { name?: string; avatar?: string | null }[];
  data?: Record<string, unknown>;
};

type KnockFeedResponse = {
  entries: KnockFeedEntry[];
  meta: { unread_count: number; unseen_count: number };
  page_info?: { after?: string | null };
};

function knockEntryToItem(entry: KnockFeedEntry): NotificationFeedItem {
  const actor = entry.actors?.[0];
  return {
    id: entry.id,
    workflow: entry.source?.key ?? "",
    insertedAt: entry.inserted_at,
    readAt: entry.read_at ?? null,
    seenAt: entry.seen_at ?? null,
    actor:
      actor && typeof actor.name === "string"
        ? { name: actor.name, avatarUrl: actor.avatar ?? null }
        : null,
    data: entry.data ?? {},
  };
}

export function knockNotificationFeedClient(
  config: NotificationFeedClientConfig
): NotificationFeedClient {
  const headers = {
    Authorization: `Bearer ${config.publicApiKey}`,
    "X-Knock-User-Token": config.userToken,
    "Content-Type": "application/json",
  };

  // The live half: one socket per signed-in user, opened when the first
  // listener arrives (the store subscribes as the provider mounts) and
  // closed in teardown — the DevUI switcher's full-page POST unmounts the
  // provider, which tears this down before a fresh client re-authenticates
  // with the new user's token. Where WebSocket is undefined (SSR render,
  // tests) the socket never opens and subscribe stays a plain listener
  // registry.
  const listeners = new Set<() => void>();
  let socket: { close: () => void } | null = null;

  function fireListeners(): void {
    for (const listener of listeners) listener();
  }

  async function request<TBody>(
    path: string,
    init?: RequestInit
  ): Promise<TBody> {
    const response = await fetch(`${KNOCK_API}${path}`, {
      headers,
      ...init,
    });
    if (!response.ok) {
      throw new Error(
        `Knock feed request failed (${response.status}): ${init?.method ?? "GET"} ${path}`
      );
    }
    return (await response.json()) as TBody;
  }

  async function listPage(cursor?: string): Promise<NotificationFeedPage> {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) params.set("after", cursor);
    const json = await request<KnockFeedResponse>(
      `/users/${config.knockUserId}/feeds/${config.feedChannelId}?${params}`
    );
    return {
      items: json.entries.map(knockEntryToItem),
      cursor: json.page_info?.after ?? null,
      unseen: json.meta.unseen_count,
      unread: json.meta.unread_count,
    };
  }

  return {
    list: listPage,

    async counts() {
      const params = new URLSearchParams({ page_size: "1" });
      const json = await request<KnockFeedResponse>(
        `/users/${config.knockUserId}/feeds/${config.feedChannelId}?${params}`
      );
      return {
        unseen: json.meta.unseen_count,
        unread: json.meta.unread_count,
      };
    },

    async markSeen(ids) {
      // An empty message_ids batch is a vendor 422, not a no-op.
      if (ids.length === 0) return;
      await request("/messages/batch/seen", {
        method: "POST",
        body: JSON.stringify({ message_ids: ids }),
      });
    },

    async markRead(ids) {
      if (ids.length === 0) return;
      await request("/messages/batch/read", {
        method: "POST",
        body: JSON.stringify({ message_ids: ids }),
      });
    },

    async markAllSeen() {
      // Bulk by channel on the user token: covers Notifications that have
      // not loaded, which a batch of loaded ids never would.
      await request(`/channels/${config.feedChannelId}/messages/bulk/seen`, {
        method: "POST",
        body: JSON.stringify({ user_ids: [config.knockUserId] }),
      });
    },

    async markAllRead() {
      await request(`/channels/${config.feedChannelId}/messages/bulk/read`, {
        method: "POST",
        body: JSON.stringify({ user_ids: [config.knockUserId] }),
      });
    },

    // Live updates: the adapter's socket fires every listener whenever a
    // message (or a status change, if the vendor ever sends one) lands on
    // the user's feed topic — the store re-reads page one in response.
    subscribe(listener) {
      listeners.add(listener);
      if (!socket && typeof WebSocket !== "undefined") {
        socket = openKnockFeedSocket(config, fireListeners);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    teardown() {
      // Leaves the feed topic and closes the socket (no reconnect), so a
      // DevUI user switch never leaks the previous user's connection.
      socket?.close();
      socket = null;
      listeners.clear();
    },
  };
}

// ─── Empty adapter (keyless dev) ───
// The app runs without Knock keys the way it runs without a Postmark token:
// the feed shows its empty state and every write is a no-op.

export function emptyNotificationFeedClient(): NotificationFeedClient {
  return {
    async list() {
      return { items: [], cursor: null, unseen: 0, unread: 0 };
    },
    async counts() {
      return { unseen: 0, unread: 0 };
    },
    async markSeen() {},
    async markRead() {},
    async markAllSeen() {},
    async markAllRead() {},
    subscribe() {
      return () => {};
    },
    teardown() {},
  };
}
