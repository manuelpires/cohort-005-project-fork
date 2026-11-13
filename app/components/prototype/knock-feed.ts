// PROTOTYPE — throwaway client plumbing for the Notification Feed UI
// prototype. Not production code; lives on the prototype branch only.
//
// Headless Knock feed access from the browser (REST + RS256 signed user
// token, exactly what the vendor spike verified). Variants render their own
// rows; this file only moves data.
import { useCallback, useEffect, useRef, useState } from "react";

export interface KnockActor {
  id?: string;
  name?: string;
  avatar_url?: string | null;
}

export interface FeedEntry {
  id: string;
  read_at: string | null;
  seen_at: string | null;
  inserted_at: string;
  data: Record<string, unknown>;
  actors?: KnockActor[];
  blocks?: { action_url?: string; rendered?: string }[];
  source?: { key?: string };
}

export interface KnockFeedState {
  entries: FeedEntry[];
  unreadCount: number | null;
  unseenCount: number | null;
  loading: boolean;
  lastError: string | null;
}

export function useKnockFeed(config: {
  publicKey: string;
  feedChannelId: string;
  knockId: string;
  token: string;
}) {
  const { publicKey, feedChannelId, knockId, token } = config;
  const [state, setState] = useState<KnockFeedState>({
    entries: [],
    unreadCount: null,
    unseenCount: null,
    loading: true,
    lastError: null,
  });
  const version = useRef(0);

  const headers = useCallback(
    (): HeadersInit => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${publicKey}`,
      "X-Knock-User-Token": token,
    }),
    [publicKey, token]
  );

  const refresh = useCallback(async () => {
    const current = ++version.current;
    try {
      const response = await fetch(
        `https://api.knock.app/v1/users/${knockId}/feeds/${feedChannelId}`,
        { headers: headers() }
      );
      if (current !== version.current) return;
      if (!response.ok) throw new Error(`Feed request failed: ${response.status}`);
      const body = await response.json();
      setState({
        entries: body.entries ?? [],
        unreadCount: body.meta?.unread_count ?? 0,
        unseenCount: body.meta?.unseen_count ?? 0,
        loading: false,
        lastError: null,
      });
    } catch (error) {
      if (current !== version.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        lastError: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [knockId, feedChannelId, headers]);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const markRead = useCallback(
    async (id: string) => {
      await fetch(`https://api.knock.app/v1/messages/${id}/read`, {
        method: "PUT",
        headers: headers(),
      });
      refresh();
    },
    [headers, refresh]
  );

  const markUnread = useCallback(
    async (id: string) => {
      await fetch(`https://api.knock.app/v1/messages/${id}/unread`, {
        method: "PUT",
        headers: headers(),
      });
      refresh();
    },
    [headers, refresh]
  );

  const markSeen = useCallback(
    async (id: string) => {
      await fetch(`https://api.knock.app/v1/messages/${id}/seen`, {
        method: "PUT",
        headers: headers(),
      });
      refresh();
    },
    [headers, refresh]
  );

  const markAllSeen = useCallback(async () => {
    setState((prev) => {
      const ids = prev.entries.filter((e) => !e.seen_at).map((e) => e.id);
      if (ids.length > 0) {
        fetch(`https://api.knock.app/v1/messages/batch/seen`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ message_ids: ids }),
        }).then(() => refresh());
      }
      return prev;
    });
  }, [headers, refresh]);

  const markAllRead = useCallback(async () => {
    const ids = state.entries.filter((e) => !e.read_at).map((e) => e.id);
    if (ids.length === 0) return;
    await fetch(`https://api.knock.app/v1/messages/batch/read`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ message_ids: ids }),
    }).catch(() => Promise.all(ids.map((id) => markRead(id))));
    refresh();
  }, [state.entries, headers, refresh, markRead]);

  return { ...state, refresh, markRead, markUnread, markSeen, markAllSeen, markAllRead };
}

export function relativeTime(iso: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function isToday(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}
