import { describe, expect, it, vi } from "vitest";
import {
  FakeNotificationFeed,
  NotificationFeedStore,
  describeNotification,
  notificationClickAction,
  unseenBadgeLabel,
  type NotificationFeedItem,
} from "./notifications-feed";

function notification(overrides: Partial<NotificationFeedItem> = {}) {
  return {
    id: "message-1",
    workflow: "discussion-question-created",
    insertedAt: "2026-11-13T10:00:00Z",
    readAt: null,
    seenAt: null,
    actor: { name: "Maria Chen", avatarUrl: null },
    data: {},
    ...overrides,
  } satisfies NotificationFeedItem;
}

describe("unseenBadgeLabel", () => {
  it("hides the badge while nothing is unseen", () => {
    expect(unseenBadgeLabel(0)).toBeNull();
  });

  it("counts unseen Notifications one through nine", () => {
    expect(unseenBadgeLabel(1)).toBe("1");
    expect(unseenBadgeLabel(9)).toBe("9");
  });

  it("caps the badge at 9+ for ten or more", () => {
    expect(unseenBadgeLabel(10)).toBe("9+");
    expect(unseenBadgeLabel(42)).toBe("9+");
  });
});

describe("describeNotification", () => {
  it("describes a Discussion Question from its trigger data", () => {
    expect(
      describeNotification(
        notification({
          workflow: "discussion-question-created",
          data: {
            kind: "discussion-question",
            commentId: 7,
            lessonTitle: "Narrowing",
            snippet: "Why does `in` not narrow here?",
            url: "/courses/ts/lessons/3#comment-7",
          },
        })
      )
    ).toEqual({
      category: "discussion",
      title: "Maria Chen asked a question",
      snippet: "“Why does `in` not narrow here?”",
    });
  });

  it("describes a Discussion Reply", () => {
    expect(
      describeNotification(
        notification({
          workflow: "discussion-reply-created",
          data: {
            kind: "discussion-reply",
            snippet: "Use a discriminated union.",
            url: "/courses/ts/lessons/3#comment-9",
          },
        })
      )
    ).toEqual({
      category: "discussion",
      title: "Maria Chen replied to your question",
      snippet: "“Use a discriminated union.”",
    });
  });

  it("describes an Open Refund Request with the amount and reason", () => {
    expect(
      describeNotification(
        notification({
          workflow: "refund-request-open",
          data: {
            kind: "open-refund-request",
            buyerName: "Maria Chen",
            courseTitle: "Total TypeScript",
            amount: "$149.00",
            reason: "Bought the wrong course by mistake.",
            url: "/admin/refunds",
          },
        })
      )
    ).toEqual({
      category: "refund",
      title: "Maria Chen requested a $149.00 refund on Total TypeScript",
      snippet: "“Bought the wrong course by mistake.”",
    });
  });

  it("describes the Refund Request confirmation as coming from Cadence", () => {
    expect(
      describeNotification(
        notification({
          workflow: "refund-request-raised",
          actor: null,
          data: {
            kind: "refund-request-confirmed",
            courseTitle: "Total TypeScript",
            url: null,
          },
        })
      )
    ).toEqual({
      category: "refund",
      title: "We've received your Refund Request",
      snippet: "A Platform Admin will review it.",
    });
  });

  it("describes a declined Refund Request with the note and the ask-again reminder", () => {
    expect(
      describeNotification(
        notification({
          workflow: "refund-request-declined",
          data: {
            kind: "refund-request-declined",
            decisionNote: "You've completed over half the course.",
            url: "/settings",
          },
        })
      )
    ).toEqual({
      category: "refund",
      title: "Your Refund Request was declined",
      snippet: "“You've completed over half the course.” You can ask again.",
    });
  });

  it("describes an approved Refund Request, quoting the note when there is one", () => {
    expect(
      describeNotification(
        notification({
          workflow: "refund-request-approved",
          data: {
            kind: "refund-request-approved",
            decisionNote: null,
            url: "/settings",
          },
        })
      )
    ).toEqual({
      category: "refund",
      title: "Your Refund Request was approved",
      snippet: null,
    });
  });

  it("describes a New Enrollment from its workflow — the growth triggers carry no kind", () => {
    expect(
      describeNotification(
        notification({
          workflow: "enrollment-created",
          data: {
            studentName: "Maria Chen",
            courseTitle: "Total TypeScript",
            url: "/instructor/1/students",
          },
        })
      )
    ).toEqual({
      category: "enrollment",
      title: "Maria Chen enrolled in Total TypeScript",
      snippet: null,
    });
  });

  it("describes a Claimed Seat with the Seats left", () => {
    expect(
      describeNotification(
        notification({
          workflow: "seat-claimed",
          data: {
            claimerName: "Maria Chen",
            courseTitle: "Total TypeScript",
            seatsLeft: 3,
            url: "/team",
          },
        })
      )
    ).toEqual({
      category: "team",
      title: "Maria Chen claimed a Seat in Total TypeScript",
      snippet: "3 Seats left",
    });
  });
});

// Three Notifications per page, oldest ids further back in history.
function history(count: number): NotificationFeedItem[] {
  const newest = new Date("2026-11-13T12:00:00Z").getTime();
  return Array.from({ length: count }, (_, index) =>
    notification({
      id: `message-${index + 1}`, // message-1 is the newest
      insertedAt: new Date(newest - index * 60_000).toISOString(),
      data: { kind: "discussion-reply", url: "/courses/ts/lessons/3" },
    })
  );
}

describe("the Notification Feed read through a fake adapter", () => {
  it("loads the newest page and its counts on refresh", async () => {
    const feed = new FakeNotificationFeed(history(5));
    const store = new NotificationFeedStore(feed);

    await store.refresh();

    const state = store.getState();
    expect(state.initialized).toBe(true);
    expect(state.items.map((item) => item.id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
    ]);
    expect(state.unseen).toBe(5);
    expect(state.unread).toBe(5);
    expect(state.hasMore).toBe(true);
  });

  it("scrolls back through history a page at a time, newest first and never duplicated", async () => {
    const feed = new FakeNotificationFeed(history(7));
    const store = new NotificationFeedStore(feed);
    await store.refresh();

    await store.loadMore();
    await store.loadMore();

    expect(store.getState().items.map((item) => item.id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
      "message-6",
      "message-7",
    ]);
    expect(store.getState().hasMore).toBe(false);
  });

  it("stops asking for pages once the history is exhausted", async () => {
    const feed = new FakeNotificationFeed(history(3));
    const store = new NotificationFeedStore(feed);
    await store.refresh();

    await store.loadMore();

    expect(feed.calls).toEqual(["list:first"]);
    expect(store.getState().hasMore).toBe(false);
  });

  it("does not fetch the same cursor twice while a page is still in flight", async () => {
    const feed = new FakeNotificationFeed(history(9));
    const store = new NotificationFeedStore(feed);
    await store.refresh();
    let release!: () => void;
    feed.gate = new Promise((resolve) => (release = resolve));

    const inFlight = store.loadMore();
    const impatient = store.loadMore();
    release();
    await Promise.all([inFlight, impatient]);

    expect(feed.calls).toEqual(["list:first", "list:3"]);
  });

  it("a refresh of page one does not rewind the cursor the user has scrolled to", async () => {
    const feed = new FakeNotificationFeed(history(9));
    const store = new NotificationFeedStore(feed);
    await store.refresh();
    await store.loadMore();

    feed.items.unshift(notification({ id: "message-0" }));
    await store.refresh();
    await store.loadMore();

    // Page one twice, then pages two and three — never page two again.
    expect(feed.calls).toEqual(["list:first", "list:3", "list:first", "list:6"]);
    expect(store.getState().items.map((item) => item.id)).toContain(
      "message-0"
    );
  });
});

describe("seen versus read", () => {
  it("opening the feed marks everything seen without marking anything read", async () => {
    const feed = new FakeNotificationFeed(history(6));
    const store = new NotificationFeedStore(feed);
    await store.refresh();

    await store.markAllSeen();
    await store.refresh();

    const state = store.getState();
    expect(state.unseen).toBe(0);
    expect(state.unread).toBe(6);
    // Bulk by channel, not a batch of the loaded ids.
    expect(feed.calls).toContain("markAllSeen");
    expect(feed.items.every((item) => item.seenAt !== null)).toBe(true);
    expect(feed.items.every((item) => item.readAt === null)).toBe(true);
  });

  it("marking all read covers Notifications that have not loaded", async () => {
    const feed = new FakeNotificationFeed(history(9));
    const store = new NotificationFeedStore(feed);
    await store.refresh(); // pages two and three stay unloaded

    await store.markAllRead();

    const state = store.getState();
    expect(state.unread).toBe(0);
    expect(state.items.every((item) => item.readAt !== null)).toBe(true);
    expect(feed.items.every((item) => item.readAt !== null)).toBe(true);
    expect(feed.calls).toContain("markAllRead");
  });

  it("the tick marks a single Notification read and disappears", async () => {
    const feed = new FakeNotificationFeed(history(4));
    const store = new NotificationFeedStore(feed);
    await store.refresh();

    await store.markRead("message-2");

    const state = store.getState();
    expect(state.unread).toBe(3);
    expect(state.unseen).toBe(4); // seen is untouched by read
    const read = state.items.find((item) => item.id === "message-2");
    expect(read?.readAt).not.toBeNull();
    expect(
      state.items
        .filter((item) => item.id !== "message-2")
        .every((item) => item.readAt === null)
    ).toBe(true);
    expect(feed.calls).toContain("markRead:1");
  });
});

describe("live updates through the adapter's subscribe", () => {
  it("a change from the adapter re-reads page one without any consumer action", async () => {
    const feed = new FakeNotificationFeed(history(3));
    const store = new NotificationFeedStore(feed);
    await store.refresh();
    expect(store.getState().unseen).toBe(3);

    // What the adapter's live socket does on a feed event.
    feed.items.unshift(
      notification({
        id: "message-0",
        insertedAt: "2026-11-13T12:30:00Z",
        data: { kind: "discussion-reply", url: "/courses/ts/lessons/3" },
      })
    );
    feed.emitChange();
    await new Promise((resolve) => setTimeout(resolve));

    const state = store.getState();
    expect(state.items.map((item) => item.id)[0]).toBe("message-0");
    expect(state.unseen).toBe(4);
  });

  it("coalesces a burst of live changes into a single trailing re-read", async () => {
    const feed = new FakeNotificationFeed(history(9));
    const store = new NotificationFeedStore(feed);
    await store.refresh();
    let release!: () => void;
    feed.gate = new Promise((resolve) => (release = resolve));

    // Three arrivals while the re-read they triggered is still in flight:
    // the socket throttles its own events, but rapid feed reads are what
    // the vendor's rate limit actually bites on (~10 rapid reads).
    feed.emitChange();
    feed.emitChange();
    feed.emitChange();
    release();
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => setTimeout(resolve));

    // The mount read, the in-flight live read, and ONE trailing read that
    // covers everything absorbed mid-flight — never one read per event.
    const reads = feed.calls.filter((call) => call === "list:first").length;
    expect(reads).toBe(3);
  });
});

describe("the live subscription's lifecycle", () => {
  it("acquiring the client wires the listener without reading anything", () => {
    const feed = new FakeNotificationFeed(history(3));
    new NotificationFeedStore(feed);

    // Opening the connection is not a feed read: reads happen on mount,
    // navigation, and socket callbacks only.
    expect(feed.calls).toEqual([]);
  });

  it("nothing polls: an idle minute adds no feed reads", async () => {
    vi.useFakeTimers();
    try {
      const feed = new FakeNotificationFeed(history(3));
      const store = new NotificationFeedStore(feed);
      await store.refresh();

      vi.advanceTimersByTime(60_000);

      expect(feed.calls).toEqual(["list:first"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("teardown unwires the listener: later vendor events read nothing", async () => {
    const feed = new FakeNotificationFeed(history(3));
    const store = new NotificationFeedStore(feed);
    await store.refresh();

    store.teardown();
    feed.emitChange();

    expect(feed.calls).toEqual(["list:first", "teardown"]);
  });

  it("re-acquiring with a new token rewires the listener on the new feed only", async () => {
    // The DevUI switcher: a full-page POST, so the provider unmounts (old
    // token's client tears down) and remounts over a freshly signed token.
    const first = new FakeNotificationFeed(history(3));
    const firstStore = new NotificationFeedStore(first);
    await firstStore.refresh();
    firstStore.teardown();

    const second = new FakeNotificationFeed(history(3));
    const secondStore = new NotificationFeedStore(second);

    second.emitChange();
    await new Promise((resolve) => setTimeout(resolve));

    expect(second.calls).toEqual(["list:first"]);
    expect(first.calls).toEqual(["list:first", "teardown"]);
    expect(first.calls.filter((call) => call === "teardown")).toHaveLength(1);
  });
});

describe("a failing vendor", () => {
  it("never breaks the feed: the refresh is best-effort and logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const feed = new FakeNotificationFeed(history(3));
    feed.list = async () => {
      throw new Error("Knock is down");
    };
    const store = new NotificationFeedStore(feed);

    await expect(store.refresh()).resolves.toBeUndefined();

    const state = store.getState();
    expect(state.initialized).toBe(true);
    expect(state.items).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe("notificationClickAction", () => {
  it("marks an unread Notification read and follows its url", () => {
    expect(
      notificationClickAction(
        notification({
          data: { url: "/courses/ts/lessons/3#comment-7" },
        })
      )
    ).toEqual({
      markRead: true,
      url: "/courses/ts/lessons/3#comment-7",
    });
  });

  it("only marks read when the Notification has nowhere to go", () => {
    expect(
      notificationClickAction(notification({ data: { url: null } }))
    ).toEqual({ markRead: true, url: null });
  });

  it("leaves an already-read Notification alone", () => {
    expect(
      notificationClickAction(
        notification({
          readAt: "2026-11-13T11:00:00Z",
          data: { url: "/team" },
        })
      )
    ).toEqual({ markRead: false, url: "/team" });
  });
});
