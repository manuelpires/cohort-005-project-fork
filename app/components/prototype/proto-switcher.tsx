// PROTOTYPE — floating variant switcher + catalogue fire controls for the
// Notification Feed UI prototype. Not production code; lives on the
// prototype branch only.
//
// Bottom-centre bar: cycle variants (arrows on screen and on keyboard), and
// an expandable strip to fire catalogue Notifications at the current user so
// the feed being judged has live rows. Clearly not part of the design under
// evaluation.
import { useEffect, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, Flame } from "lucide-react";
import type { useKnockFeed } from "./knock-feed";

export const VARIANTS = [
  { key: "A", name: "Popover in sidebar" },
  { key: "B", name: "Dedicated page" },
  { key: "C", name: "Right drawer" },
] as const;

export type VariantKey = (typeof VARIANTS)[number]["key"];

const CATALOGUE = [
  { intent: "fire-discussion-reply", label: "Discussion Reply" },
  { intent: "fire-discussion-question", label: "Discussion Question" },
  { intent: "fire-new-enrollment", label: "New Enrollment" },
  { intent: "fire-refund-approved", label: "Refund Approved" },
  { intent: "fire-claimed-seat", label: "Claimed Seat" },
] as const;

export function ProtoSwitcher({
  variant,
  onChange,
  feed,
}: {
  variant: VariantKey;
  onChange: (next: VariantKey) => void;
  feed: ReturnType<typeof useKnockFeed>;
}) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const fetcher = useFetcher<{ fired?: string[]; error?: string }>();

  function cycle(direction: 1 | -1) {
    const index = VARIANTS.findIndex((v) => v.key === variant);
    const next = VARIANTS[(index + direction + VARIANTS.length) % VARIANTS.length];
    navigate(`/prototype/notifications?variant=${next.key}`, { replace: true });
    onChange(next.key);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight"
      ) {
        return;
      }
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      cycle(event.key === "ArrowRight" ? 1 : -1);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0];
  const busy = fetcher.state !== "idle";

  if (!import.meta.env.DEV) return null;

  // Refresh the feed shortly after firing so the new Notification lands
  // while it's being watched.
  useEffect(() => {
    if (fetcher.data?.fired && fetcher.state === "idle") {
      const first = setTimeout(() => feed.refresh(), 1200);
      const second = setTimeout(() => feed.refresh(), 3000);
      return () => {
        clearTimeout(first);
        clearTimeout(second);
      };
    }
  }, [fetcher.data, fetcher.state, feed]);

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {expanded && (
        <div className="flex max-w-[92vw] flex-wrap items-center justify-center gap-1.5 rounded-xl border border-purple-300/60 bg-purple-950/95 px-3 py-2 text-white shadow-xl">
          <span className="px-1 text-xs font-semibold uppercase tracking-wide text-purple-300">
            Fire at you:
          </span>
          {CATALOGUE.map((item) => (
            <button
              key={item.intent}
              onClick={() =>
                fetcher.submit(
                  { intent: item.intent },
                  { method: "POST", action: "/prototype/notifications" }
                )
              }
              disabled={busy}
              className="rounded-full border border-purple-400/50 px-2.5 py-1 text-xs transition-colors hover:bg-purple-800 disabled:opacity-40"
            >
              {item.label}
            </button>
          ))}
          <button
            onClick={() =>
              fetcher.submit(
                { intent: "fire-all" },
                { method: "POST", action: "/prototype/notifications" }
              )
            }
            disabled={busy}
            className="rounded-full bg-purple-500 px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-purple-400 disabled:opacity-40"
          >
            All
          </button>
        </div>
      )}

      <div className="flex items-center gap-1 rounded-xl border border-purple-300/60 bg-purple-950/95 px-2 py-1.5 text-white shadow-xl">
        <button
          onClick={() => cycle(-1)}
          className="rounded-lg p-1.5 transition-colors hover:bg-purple-800"
          title="Previous variant (←)"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-40 text-center text-sm font-semibold">
          {current.key} · {current.name}
        </span>
        <button
          onClick={() => cycle(1)}
          className="rounded-lg p-1.5 transition-colors hover:bg-purple-800"
          title="Next variant (→)"
        >
          <ChevronRight className="size-4" />
        </button>
        <span className="mx-1 h-5 w-px bg-purple-400/40" />
        <button
          onClick={() => setExpanded((value) => !value)}
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors hover:bg-purple-800"
        >
          <Flame className="size-3.5" />
          Catalogue
        </button>
      </div>

      <div className="rounded-full border border-purple-300/40 bg-purple-950/90 px-3 py-0.5 font-mono text-[10px] text-purple-200 shadow">
        unread {feed.unreadCount ?? "?"} · unseen {feed.unseenCount ?? "?"} ·{" "}
        {feed.entries.length} items
        {feed.lastError ? ` · ERROR ${feed.lastError}` : ""}
        {busy ? " · firing…" : ""}
        {fetcher.data?.error ? ` · ${fetcher.data.error}` : ""}
      </div>
    </div>
  );
}
