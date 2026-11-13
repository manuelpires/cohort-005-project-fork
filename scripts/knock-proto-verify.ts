// PROTOTYPE — throwaway verification for the Knock vendor spike (wayfinder
// ticket "Does Knock hold up against Cadence?"). Runs the four checks against
// the live dev environment and prints a verdict per check.
//
//   set -a; source .env; set +a; npx tsx scripts/knock-proto-verify.ts
import {
  knockUserId,
  signCadenceUserToken,
  triggerDiscussionReply,
  triggerNewEnrollment,
} from "../app/lib/knock-proto.server";

const API = "https://api.knock.app";
const EMMA = { id: 5, name: "Emma Wilson", email: "emma.wilson@student.dev" }; // Student, question author
const SARAH = { id: 2, name: "Sarah Chen", email: "sarah.chen@ralph.dev" }; // Instructor, course 1
const JAMES = { id: 6, name: "James Park", email: "james.park@student.dev" }; // Student, control user

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const publicKey = requireEnv("KNOCK_PUBLIC_API_KEY");
const feedChannelId = requireEnv("KNOCK_FEED_CHANNEL_ID");

function authHeaders(token: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${publicKey}`,
    "X-Knock-User-Token": token,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFeed(userId: number, token: string) {
  const response = await fetch(
    `${API}/v1/users/${knockUserId(userId)}/feeds/${feedChannelId}?page_size=50`,
    { headers: authHeaders(token) }
  );
  return { status: response.status, body: await response.json() };
}

const verdicts: Array<[string, boolean, string]> = [];
const note = (check: string, pass: boolean, detail: string) => {
  verdicts.push([check, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
};

async function main() {
  // ── Check 1: signed user tokens ──────────────────────────────────────────
  const emmaToken = await signCadenceUserToken(EMMA.id);
  const jamesToken = await signCadenceUserToken(JAMES.id);

  const emmaFeed = await getFeed(EMMA.id, emmaToken);
  note(
    "1a. feed request with public key + RS256 user token",
    emmaFeed.status === 200,
    `GET feed → ${emmaFeed.status}`
  );

  const unsigned = await fetch(
    `${API}/v1/users/${knockUserId(EMMA.id)}/feeds/${feedChannelId}`,
    { headers: { Authorization: `Bearer ${publicKey}` } }
  );
  const unsignedBody = await unsigned.json();
  note(
    "1b. enhanced security rejects public key without user token",
    unsigned.status === 400 && unsignedBody.code === "missing_user_token",
    `GET feed without token → ${unsigned.status} ${String(unsignedBody.code)} (documented rejection)`
  );

  // cross-user token check: Emma's token cannot read James's feed
  const cross = await fetch(
    `${API}/v1/users/${knockUserId(JAMES.id)}/feeds/${feedChannelId}`,
    { headers: authHeaders(emmaToken) }
  );
  note(
    "1c. a user token cannot read another user's feed",
    cross.status === 401 || cross.status === 403,
    `GET James's feed with Emma's token → ${cross.status}`
  );

  // ── Check 2: triggering ──────────────────────────────────────────────────
  const before = await getFeed(EMMA.id, emmaToken);
  const trigger = await triggerDiscussionReply({
    questionAuthor: { ...EMMA, avatarUrl: null },
    replier: SARAH,
    courseTitle: "Introduction to TypeScript",
    lessonTitle: "Your First TypeScript Program",
    questionSnippet: "Why does const behave differently here?",
    replySnippet: "Great question — const binds the name, not the value.",
    lessonUrl: "/courses/introduction-to-typescript/lessons/2",
  });
  await sleep(2500);
  const after = await getFeed(EMMA.id, emmaToken);
  const newEntries = (after.body.entries ?? []).filter(
    (e: { id: string }) => !(before.body.entries ?? []).some((b: { id: string }) => b.id === e.id)
  );
  note(
    "2. Node SDK triggers Discussion Reply → question author's feed",
    trigger.workflow_run_id !== undefined &&
      newEntries.length === 1 &&
      newEntries[0].source?.key === "discussion-reply",
    `run ${String(trigger.workflow_run_id).slice(0, 8)}…, ${newEntries.length} new entr${
      newEntries.length === 1 ? "y" : "ies"
    }${newEntries[0] ? ` from workflow ${newEntries[0].source?.key}` : ""}`
  );

  // ── Check 3: headless feed API ───────────────────────────────────────────
  const withCounts = await getFeed(EMMA.id, emmaToken);
  const unreadBefore = withCounts.body.meta?.unread_count;
  const unseenBefore = withCounts.body.meta?.unseen_count;
  const firstMessage: string | undefined = withCounts.body.entries?.[0]?.id;

  let readOk = false;
  let seenOk = false;
  let countsOk = false;
  if (firstMessage) {
    const read = await fetch(`${API}/v1/messages/${firstMessage}/read`, {
      method: "PUT",
      headers: authHeaders(emmaToken),
    });
    readOk = read.status === 200;
    const seen = await fetch(`${API}/v1/messages/${firstMessage}/seen`, {
      method: "PUT",
      headers: authHeaders(emmaToken),
    });
    seenOk = seen.status === 200;
    await sleep(500);
    const recounted = await getFeed(EMMA.id, emmaToken);
    countsOk =
      recounted.body.meta?.unread_count === Math.max(0, unreadBefore - 1) &&
      recounted.body.meta?.unseen_count === Math.max(0, unseenBefore - 1) &&
      recounted.body.entries?.find((e: { id: string }) => e.id === firstMessage)?.read_at != null;
  }
  note(
    "3a. mark read/seen + unread counts via REST",
    readOk && seenOk && countsOk,
    `mark read ${readOk ? "ok" : "FAILED"}, mark seen ${seenOk ? "ok" : "FAILED"}, unread ${unreadBefore}→${countsOk ? Math.max(0, unreadBefore - 1) : "?"}`
  );

  const batch = await fetch(`${API}/v1/messages/batch/seen`, {
    method: "POST",
    headers: authHeaders(emmaToken),
    body: JSON.stringify({ message_ids: (withCounts.body.entries ?? []).map((e: { id: string }) => e.id) }),
  });
  await sleep(500);
  const afterBatch = await getFeed(EMMA.id, emmaToken);
  note(
    "3b. batch mark seen",
    batch.status === 200 && afterBatch.body.meta?.unseen_count === 0,
    `batch/seen → ${batch.status}, unseen after → ${afterBatch.body.meta?.unseen_count}`
  );

  // ── Check 4: preferences (off by default, opt-in) ────────────────────────
  // Sarah is the instructor of course 1. The enrollments category is off in
  // the environment default preference set, and Sarah has no explicit
  // preference, so a new Enrollment notification must NOT create a message.
  const sarahToken = await signCadenceUserToken(SARAH.id);
  await fetch(`${API}/v1/users/${knockUserId(SARAH.id)}/preferences/default`, {
    method: "PUT",
    headers: authHeaders(sarahToken),
    body: JSON.stringify({ __persistence_strategy__: "replace", categories: {}, channel_types: {}, workflows: {} }),
  });
  const suppressedRun = await triggerNewEnrollment({
    instructor: SARAH,
    student: JAMES,
    courseTitle: "Introduction to TypeScript",
  });
  await sleep(2500);
  const sarahFeedSuppressed = await getFeed(SARAH.id, sarahToken);
  const suppressedEntries = (sarahFeedSuppressed.body.entries ?? []).filter(
    (e: { source?: { key?: string } }) => e.source?.key === "new-enrollment"
  );
  note(
    "4a. new Enrollment is off by default (suppressed without opt-in)",
    suppressedRun.workflow_run_id !== undefined && suppressedEntries.length === 0,
    `run ${String(suppressedRun.workflow_run_id).slice(0, 8)}… produced ${suppressedEntries.length} feed items (expected 0)`
  );

  const optIn = await fetch(
    `${API}/v1/users/${knockUserId(SARAH.id)}/preferences/default`,
    {
      method: "PUT",
      headers: authHeaders(sarahToken),
      body: JSON.stringify({
        __persistence_strategy__: "merge",
        categories: { enrollments: { channel_types: { in_app_feed: true } } },
      }),
    }
  );
  const prefsAfter = await fetch(
    `${API}/v1/users/${knockUserId(SARAH.id)}/preferences/default`,
    { headers: authHeaders(sarahToken) }
  ).then((r) => r.json());
  const optedInRun = await triggerNewEnrollment({
    instructor: SARAH,
    student: JAMES,
    courseTitle: "Introduction to TypeScript",
  });
  await sleep(2500);
  const sarahFeedOptedIn = await getFeed(SARAH.id, sarahToken);
  const optedEntries = (sarahFeedOptedIn.body.entries ?? []).filter(
    (e: { source?: { key?: string } }) => e.source?.key === "new-enrollment"
  );
  const prefVisible = prefsAfter.categories?.enrollments?.channel_types?.in_app_feed === true;
  note(
    "4b. opt-in turns new Enrollment on, and the preference set records it",
    optIn.status === 200 && prefVisible && optedEntries.length >= 1,
    `PUT prefs → ${optIn.status}, enrollments/in_app_feed=${String(
      prefsAfter.categories?.enrollments?.channel_types?.in_app_feed
    )}, ${optedEntries.length} feed item(s) after opt-in`
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = verdicts.filter(([, pass]) => !pass);
  console.log(`\n${verdicts.length - failed.length}/${verdicts.length} checks passed.`);
  if (failed.length > 0) process.exit(1);
}

main();
