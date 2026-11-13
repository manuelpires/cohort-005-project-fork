// PROTOTYPE ROUTE — throwaway Knock vendor spike (wayfinder ticket "Does Knock
// hold up against Cadence?"). Never ships; lives on the prototype branch only.
//
// The question: do all four checks pass against the real app?
//   1. Signed user tokens: the server signs an RS256 token for the DevUI-selected
//      user; the browser authenticates to Knock with it; switching users
//      (DevUI) switches the feed.
//   2. Triggering: the Node SDK triggers a real catalogue Notification
//      (Discussion Reply → question author) that lands in that user's feed.
//   3. Headless feed API: listing items, unread count, mark read/seen — all via
//      plain REST from the browser, no vendor React components.
//   4. Preferences: category × channel entries that are off by default and
//      opt-in (new Enrollment → Instructor).
import type { Route } from "./+types/prototype.knock";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { users, courses, modules, lessons, comments } from "~/db/schema";
import { eq, isNotNull, ne, and } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  knockUserId,
  signCadenceUserToken,
  triggerDiscussionReply,
  triggerNewEnrollment,
} from "~/lib/knock-proto.server";

function getUser(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  const currentUser = userId ? getUser(userId) : null;

  const publicKey = process.env.KNOCK_PUBLIC_API_KEY ?? null;
  const feedChannelId = process.env.KNOCK_FEED_CHANNEL_ID ?? null;
  if (!currentUser || !publicKey || !feedChannelId) {
    return {
      ready: false as const,
      currentUser: currentUser
        ? { id: currentUser.id, name: currentUser.name, role: currentUser.role }
        : null,
    };
  }

  // The real Discussion Reply the trigger button fires: Sarah Chen's reply to
  // Emma Wilson's Discussion Question (seed data).
  const reply = alias(comments, "reply");
  const question = alias(comments, "question");
  const pairing = db
    .select({
      questionAuthor: {
        id: question.userId,
      },
      replierId: reply.userId,
      lessonTitle: lessons.title,
      lessonId: lessons.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      questionBody: question.body,
      replyBody: reply.body,
    })
    .from(reply)
    .innerJoin(question, eq(reply.parentId, question.id))
    .innerJoin(lessons, eq(reply.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(and(isNotNull(reply.parentId), ne(reply.userId, question.userId)))
    .get();

  const token = await signCadenceUserToken(currentUser.id);

  return {
    ready: true as const,
    currentUser: {
      id: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
    },
    knockId: knockUserId(currentUser.id),
    publicKey,
    feedChannelId,
    // token is short-lived (1h) and only for this throwaway page
    token,
    pairing: pairing
      ? {
          questionAuthorId: pairing.questionAuthor.id,
          replierId: pairing.replierId,
          courseTitle: pairing.courseTitle,
          lessonTitle: pairing.lessonTitle,
          lessonUrl: `/courses/${pairing.courseSlug}/lessons/${pairing.lessonId}`,
          questionSnippet: pairing.questionBody.slice(0, 80),
          replySnippet: pairing.replyBody.slice(0, 80),
        }
      : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  const currentUser = userId ? getUser(userId) : null;
  if (!currentUser) {
    return { error: "Select a user from the DevUI panel" };
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "trigger-discussion-reply") {
      const reply = alias(comments, "reply");
      const question = alias(comments, "question");
      const pairing = db
        .select({
          authorId: question.userId,
          replierId: reply.userId,
          lessonTitle: lessons.title,
          lessonId: lessons.id,
          courseTitle: courses.title,
          courseSlug: courses.slug,
          questionBody: question.body,
          replyBody: reply.body,
        })
        .from(reply)
        .innerJoin(question, eq(reply.parentId, question.id))
        .innerJoin(lessons, eq(reply.lessonId, lessons.id))
        .innerJoin(modules, eq(lessons.moduleId, modules.id))
        .innerJoin(courses, eq(modules.courseId, courses.id))
        .where(and(isNotNull(reply.parentId), ne(reply.userId, question.userId)))
        .get();
      if (!pairing) return { error: "No seed Discussion Reply found" };

      const author = getUser(pairing.authorId);
      const replier = getUser(pairing.replierId);
      if (!author || !replier) return { error: "Seed users missing" };

      const result = await triggerDiscussionReply({
        questionAuthor: {
          id: author.id,
          name: author.name,
          email: author.email,
          avatarUrl: author.avatarUrl,
        },
        replier: { id: replier.id, name: replier.name, email: replier.email },
        courseTitle: pairing.courseTitle,
        lessonTitle: pairing.lessonTitle,
        questionSnippet: pairing.questionBody.slice(0, 120),
        replySnippet: pairing.replyBody.slice(0, 120),
        lessonUrl: `/courses/${pairing.courseSlug}/lessons/${pairing.lessonId}`,
      });
      return {
        intent,
        recipient: `${author.name} (question author, id ${author.id})`,
        workflowRunId: result.workflow_run_id,
      };
    }

    if (intent === "trigger-new-enrollment") {
      const course = db.select().from(courses).where(eq(courses.id, 1)).get();
      const instructor = course ? getUser(course.instructorId) : null;
      const student = getUser(6); // James Park, a seed Student
      if (!course || !instructor || !student) {
        return { error: "Seed course/instructor/student missing" };
      }
      const result = await triggerNewEnrollment({
        instructor: { id: instructor.id, name: instructor.name, email: instructor.email },
        student: { id: student.id, name: student.name, email: student.email },
        courseTitle: course.title,
      });
      return {
        intent,
        recipient: `${instructor.name} (instructor, id ${instructor.id})`,
        workflowRunId: result.workflow_run_id,
      };
    }

    return { error: `Unknown intent: ${intent}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export default function PrototypeKnock({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.ready) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold">Knock prototype — not ready</h1>
        <p className="mt-2 text-muted-foreground">
          {loaderData.currentUser
            ? "KNOCK_PUBLIC_API_KEY or KNOCK_FEED_CHANNEL_ID missing from .env."
            : "Select a user from the DevUI panel, then reload."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">
        <span className="rounded bg-purple-600 px-2 py-0.5 text-xs font-semibold uppercase text-white mr-2">
          Prototype
        </span>
        Knock vendor spike
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Throwaway check of the four vendor-fit questions. Referenced by wayfinder ticket
        &quot;Does Knock hold up against Cadence?&quot;.
      </p>

      <KnockSpikeClient
        currentUser={loaderData.currentUser}
        knockId={loaderData.knockId}
        publicKey={loaderData.publicKey}
        feedChannelId={loaderData.feedChannelId}
        token={loaderData.token}
        pairing={loaderData.pairing}
        lastAction={actionData ?? null}
      />
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useFetcher } from "react-router";

interface SpikeProps {
  currentUser: { id: number; name: string; role: string };
  knockId: string;
  publicKey: string;
  feedChannelId: string;
  token: string;
  pairing: {
    questionAuthorId: number;
    replierId: number;
    courseTitle: string;
    lessonTitle: string;
    lessonUrl: string;
    questionSnippet: string;
    replySnippet: string;
  } | null;
  lastAction: { error?: string; intent?: string; recipient?: string; workflowRunId?: string } | null;
}

interface FeedEntry {
  id: string;
  read_at: string | null;
  seen_at: string | null;
  inserted_at: string;
  data: Record<string, unknown>;
  blocks?: { rendered?: string }[];
  source?: { key?: string };
}

interface FeedState {
  entries: FeedEntry[];
  unreadCount: number | null;
  unseenCount: number | null;
}

function KnockSpikeClient(props: SpikeProps) {
  const { publicKey, knockId, feedChannelId, token } = props;
  const [feed, setFeed] = useState<FeedState | null>(null);
  const [prefs, setPrefs] = useState<unknown>(null);
  const [log, setLog] = useState<string[]>([]);
  const fetcher = useFetcher<{ error?: string; intent?: string; recipient?: string; workflowRunId?: string }>();

  const headers = useCallback(
    (withToken = true): HeadersInit => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${publicKey}`,
      ...(withToken ? { "X-Knock-User-Token": token } : {}),
    }),
    [publicKey, token]
  );

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()} ${line}`, ...prev].slice(0, 30));
  }, []);

  const refreshFeed = useCallback(async () => {
    const response = await fetch(
      `https://api.knock.app/v1/users/${knockId}/feeds/${feedChannelId}`,
      { headers: headers(true) }
    );
    const body = await response.json();
    appendLog(`GET feed → ${response.status} (unread ${body.meta?.unread_count ?? "?"}, unseen ${body.meta?.unseen_count ?? "?"})`);
    setFeed({
      entries: body.entries ?? [],
      unreadCount: body.meta?.unread_count ?? null,
      unseenCount: body.meta?.unseen_count ?? null,
    });
  }, [knockId, feedChannelId, headers, appendLog]);

  const refreshPrefs = useCallback(async () => {
    const response = await fetch(
      `https://api.knock.app/v1/users/${knockId}/preferences/default`,
      { headers: headers(true) }
    );
    appendLog(`GET preferences → ${response.status}`);
    setPrefs(response.ok ? await response.json() : { error: await response.json() });
  }, [knockId, headers, appendLog]);

  useEffect(() => {
    refreshFeed();
    refreshPrefs();
  }, [refreshFeed, refreshPrefs]);

  async function markMessage(id: string, status: "read" | "seen") {
    const response = await fetch(`https://api.knock.app/v1/messages/${id}/${status}`, {
      method: "PUT",
      headers: headers(true),
    });
    appendLog(`PUT message ${id.slice(0, 8)}… ${status} → ${response.status}`);
    refreshFeed();
  }

  async function markAllSeen() {
    if (!feed) return;
    const response = await fetch(`https://api.knock.app/v1/messages/batch/seen`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ message_ids: feed.entries.map((e) => e.id) }),
    });
    appendLog(`POST batch/seen (${feed.entries.length} ids) → ${response.status}`);
    refreshFeed();
  }

  async function probeUnsigned() {
    const response = await fetch(
      `https://api.knock.app/v1/users/${knockId}/feeds/${feedChannelId}`,
      { headers: headers(false) }
    );
    appendLog(`GET feed WITHOUT user token → ${response.status} (enhanced security check; expect 401)`);
  }

  async function setEnrollmentPreference(optIn: boolean) {
    const response = await fetch(
      `https://api.knock.app/v1/users/${knockId}/preferences/default`,
      {
        method: "PUT",
        headers: headers(true),
        body: JSON.stringify({
          __persistence_strategy__: "merge",
          categories: {
            enrollments: { channel_types: { in_app_feed: optIn } },
          },
        }),
      }
    );
    appendLog(`PUT preferences enrollments/in_app_feed=${optIn} → ${response.status}`);
    refreshPrefs();
  }

  function trigger(intent: string) {
    fetcher.submit({ intent }, { method: "POST", action: "/prototype/knock" });
  }

  useEffect(() => {
    if (fetcher.data) {
      const body = fetcher.data;
      appendLog(
        `TRIGGER ${body.intent ?? "?"} → ${fetcher.state}${
          body.workflowRunId ? ` run ${String(body.workflowRunId).slice(0, 8)}…` : ""
        }${body.recipient ? ` recipient ${body.recipient}` : ""}${body.error ? ` error ${body.error}` : ""}`
      );
      if (body.workflowRunId) {
        const t = setTimeout(() => {
          refreshFeed();
        }, 1500);
        return () => clearTimeout(t);
      }
    }
  }, [fetcher.data, fetcher.state, appendLog, refreshFeed]);

  const enrollmentPref = (() => {
    if (!prefs || typeof prefs !== "object") return null;
    const set = prefs as {
      categories?: { enrollments?: { channel_types?: { in_app_feed?: boolean } } };
    };
    const value = set.categories?.enrollments?.channel_types?.in_app_feed;
    return typeof value === "boolean" ? value : null;
  })();

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-lg border p-4">
        <h2 className="font-semibold">
          Signed in as {props.currentUser.name} ({props.currentUser.role})
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Knock id <code>{knockId}</code>, RS256 token minted server-side for the DevUI-selected
          user. Switch users in the DevUI panel and reload — the feed and preferences below
          belong to whichever user is selected.
        </p>
        <button
          onClick={probeUnsigned}
          className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Probe feed API without user token (expect 401)
        </button>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-semibold">Trigger catalogue Notifications (server SDK)</h2>
        {props.pairing ? (
          <p className="mt-1 text-sm text-muted-foreground">
            Discussion Reply: replier id {props.pairing.replierId} → question author id{" "}
            {props.pairing.questionAuthorId}, on &quot;{props.pairing.lessonTitle}&quot;. New
            Enrollment: a Student → instructor of &quot;{props.pairing.courseTitle}&quot;. Switch
            to the recipient in the DevUI to see it land.
          </p>
        ) : null}
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => trigger("trigger-discussion-reply")}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Trigger Discussion Reply → question author
          </button>
          <button
            onClick={() => trigger("trigger-new-enrollment")}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            Trigger new Enrollment → instructor
          </button>
        </div>
        {props.lastAction?.error ? (
          <p className="mt-2 text-sm text-red-600">Last trigger error: {props.lastAction.error}</p>
        ) : null}
      </section>

      <section className="rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">
            Notification Feed (headless REST, user token auth)
          </h2>
          <div className="flex gap-2">
            <button onClick={refreshFeed} className="rounded border px-2 py-1 text-xs hover:bg-accent">
              Refresh
            </button>
            <button onClick={markAllSeen} className="rounded border px-2 py-1 text-xs hover:bg-accent">
              Mark all seen
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          unread: {feed?.unreadCount ?? "…"} · unseen: {feed?.unseenCount ?? "…"} ·{" "}
          {feed?.entries.length ?? 0} items
        </p>
        <ul className="mt-2 space-y-2">
          {(feed?.entries ?? []).map((entry) => (
            <li key={entry.id} className="rounded border p-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {entry.source?.key ?? "?"}
                  {!entry.read_at && (
                    <span className="ml-2 rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                      unread
                    </span>
                  )}
                </span>
                <span className="flex gap-1">
                  <button
                    onClick={() => markMessage(entry.id, "read")}
                    className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent"
                  >
                    mark read
                  </button>
                  <button
                    onClick={() => markMessage(entry.id, "seen")}
                    className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent"
                  >
                    mark seen
                  </button>
                </span>
              </div>
              <p className="mt-1 text-muted-foreground">
                {entry.blocks?.map((b) => b.rendered ?? "").join(" ") ||
                  JSON.stringify(entry.data)}
              </p>
            </li>
          ))}
          {feed && feed.entries.length === 0 ? (
            <li className="text-sm text-muted-foreground">Empty feed.</li>
          ) : null}
        </ul>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-semibold">Preferences (category × channel)</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          enrollments on the in-app feed:{" "}
          {enrollmentPref === null ? "unset (falls back to environment default: OFF)" : String(enrollmentPref)}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => setEnrollmentPreference(true)}
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
          >
            Opt in (true)
          </button>
          <button
            onClick={() => setEnrollmentPreference(false)}
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
          >
            Opt out (false)
          </button>
        </div>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Raw preference set
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
            {JSON.stringify(prefs, null, 2)}
          </pre>
        </details>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="font-semibold">API log</h2>
        <pre className="mt-1 max-h-48 overflow-auto text-xs">{log.join("\n")}</pre>
      </section>
    </div>
  );
}
