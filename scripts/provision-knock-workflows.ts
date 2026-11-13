// Idempotent provisioning of the Notification catalogue in Knock's
// Development environment, via the Management API (control.knock.app, which
// authenticates with a service token — never an environment API key).
//
// Each workflow is created or updated under its deterministic key, tagged
// with its preference category (the same keys the server port maps onto
// Knock category keys), given one in-app feed step on the Cadence feed
// channel, and committed — a workflow's category only exists at runtime once
// the workflow is committed, and triggering an uncommitted workflow 404s.
// Cadence writes the notification text client-side, so the step's template
// body is a fallback, not the source of truth.
//
// Safe to re-run: the upsert converges on the same content, and an empty
// commit is allowed when nothing changed. Run with
// `npm run notifications:provision-workflows`.
process.loadEnvFile(".env");

const MANAGEMENT_API = "https://control.knock.app/v1";
const ENVIRONMENT = "development";

type CategorySpec = {
  key: string;
  description?: string;
};

type WorkflowSpec = {
  key: string;
  name: string;
  description: string;
  category: string;
  markdownBody: string;
};

// The six preference categories of the Notification catalogue. They must
// exist in the project's preference category catalog before a workflow can
// reference them, so each is upserted first.
const PREFERENCE_CATEGORIES: CategorySpec[] = [
  { key: "refund-request-updates" },
  { key: "open-refund-requests" },
  { key: "seat-claims" },
  { key: "enrollments" },
  {
    key: "discussion-questions",
    description: "Notifications about new Discussion Questions on your lessons",
  },
  {
    key: "discussion-replies",
    description: "Notifications about replies to your Discussion Questions",
  },
];

const WORKFLOWS: WorkflowSpec[] = [
  {
    key: "refund-request-raised",
    name: "Refund Request Raised",
    description:
      "Confirms to the buyer their Refund Request is under review (course, amount).",
    category: "refund-request-updates",
    markdownBody: "{{ workflow.name }} for {{ recipient.name }}",
  },
  {
    key: "refund-request-approved",
    name: "Refund Request Approved",
    description:
      "Tells the buyer their Refund Request was approved, with any decision note.",
    category: "refund-request-updates",
    markdownBody: "{{ workflow.name }} for {{ recipient.name }}",
  },
  {
    key: "refund-request-declined",
    name: "Refund Request Declined",
    description:
      "Tells the buyer their Refund Request was declined, with the decision note.",
    category: "refund-request-updates",
    markdownBody: "{{ workflow.name }} for {{ recipient.name }}",
  },
  {
    key: "refund-request-open",
    name: "Open Refund Request",
    description:
      "Tells every Platform Admin who asked for a refund, for which course, and why.",
    category: "open-refund-requests",
    markdownBody: "{{ workflow.name }} for {{ recipient.name }}",
  },
  {
    key: "seat-claimed",
    name: "Seat claimed",
    description:
      "A Student claimed a Seat on a Team Licence. Recipient: the Team Admin who owns the licence.",
    category: "seat-claims",
    markdownBody:
      "{{ actor.name }} claimed a Seat in {{ data.courseTitle }} — {{ data.seatsLeft }} left",
  },
  {
    key: "enrollment-created",
    name: "Enrollment created",
    description:
      "A Student enrolled on a course through an Individual Purchase or a Claimed Seat. Recipient: the course's Instructor. Off by default; the recipient opts in through the Enrollments preference.",
    category: "enrollments",
    markdownBody: "{{ actor.name }} enrolled in {{ data.courseTitle }}",
  },
  {
    key: "discussion-question-created",
    name: "Discussion Question created",
    description:
      "Someone other than the course's Instructor asked a Discussion Question on the Instructor's lesson.",
    category: "discussion-questions",
    markdownBody:
      "{{ actor.name }} asked a question on {{ data.lessonTitle }}",
  },
  {
    key: "discussion-reply-created",
    name: "Discussion Reply created",
    description:
      "Someone other than the author replied to the author's Discussion Question.",
    category: "discussion-replies",
    markdownBody:
      "{{ actor.name }} replied to your question on {{ data.lessonTitle }}",
  },
];

function serviceToken(): string {
  const token = process.env.KNOCK_SERVICE_TOKEN;
  if (!token) {
    throw new Error("KNOCK_SERVICE_TOKEN is missing from .env");
  }
  return token;
}

function feedChannelKey(): string {
  const key = process.env.KNOCK_FEED_CHANNEL_KEY;
  if (!key) {
    throw new Error("KNOCK_FEED_CHANNEL_KEY is missing from .env");
  }
  return key;
}

async function management(
  token: string,
  path: string,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  const response = await fetch(`${MANAGEMENT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(body)}`
    );
  }
  return body as Record<string, unknown>;
}

async function upsertCategory(token: string, spec: CategorySpec) {
  // Upserting by name is idempotent; a workflow's category must already
  // exist in the catalog before the workflow can reference it.
  await management(token, `/preference_categories/${spec.key}`, {
    method: "PUT",
    body: JSON.stringify({
      name: spec.key,
      ...(spec.description ? { description: spec.description } : {}),
    }),
  });
  console.log(`preference category ${spec.key}: upserted.`);
}

async function provisionWorkflow(
  token: string,
  channelKey: string,
  spec: WorkflowSpec
) {
  const workflowBody = {
    name: spec.name,
    description: spec.description,
    categories: [spec.category],
    steps: [
      {
        name: "Notification Feed",
        type: "channel",
        ref: "feed",
        channel_type: "in_app_feed",
        channel_key: channelKey,
        template: {
          action_url: "{{ data.url }}",
          markdown_body: spec.markdownBody,
        },
      },
    ],
    trigger_frequency: "every_trigger",
  };

  const query = new URLSearchParams({
    environment: ENVIRONMENT,
    commit: "true",
    commit_message: `Provision ${spec.key} (Cadence Notification catalogue)`,
    allow_empty: "true",
  });
  await management(token, `/workflows/${spec.key}?${query}`, {
    method: "PUT",
    body: JSON.stringify({ workflow: workflowBody }),
  });

  const verified = await management(
    token,
    `/workflows/${spec.key}?environment=${ENVIRONMENT}`
  );
  const active = verified.active === true;
  const categories = verified.categories as string[] | undefined;
  if (!active || !categories?.includes(spec.category)) {
    throw new Error(
      `${spec.key} is not ready: active=${active} categories=${JSON.stringify(categories)}`
    );
  }
  console.log(
    `${spec.key}: committed, active, category "${spec.category}".`
  );
}

async function main() {
  const token = serviceToken();
  const channelKey = feedChannelKey();

  for (const category of PREFERENCE_CATEGORIES) {
    await upsertCategory(token, category);
  }
  for (const spec of WORKFLOWS) {
    await provisionWorkflow(token, channelKey, spec);
  }
  console.log("Notification workflows provisioned.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
