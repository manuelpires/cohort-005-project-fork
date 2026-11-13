// Provisions the Discussion Notification workflows in the Knock development
// environment, idempotently, through the Management API (control plane).
// Run it with `npm run notifications:provision-discussions`; re-running is a
// no-op — every call is an upsert with deterministic keys.
//
// What it ensures exists and is committed:
//   - preference categories `discussion-questions` and `discussion-replies`
//   - workflow `discussion-question-created` tagged `discussion-questions`
//   - workflow `discussion-reply-created` tagged `discussion-replies`
//
// Each workflow carries its preference category and an in-app feed step on
// the Cadence feed channel; a category only exists at runtime once a
// workflow referencing it is committed. The feed renders from trigger data
// in Cadence's own UI, so the templates stay deliberately minimal.
//
// Requires KNOCK_SERVICE_TOKEN and KNOCK_FEED_CHANNEL_KEY in .env. Never
// runs as part of the app or the tests — vendor provisioning is a
// developer-on-you-machine task, like the seed.
import { loadEnvFile } from "node:process";

// Vite doesn't put non-VITE_ vars on process.env, so load .env ourselves.
try {
  loadEnvFile(".env");
} catch {
  // A missing .env just means the guard below fails with a clear error.
}

const CONTROL_API = "https://control.knock.app/v1";

const SERVICE_TOKEN = process.env.KNOCK_SERVICE_TOKEN;
const FEED_CHANNEL_KEY = process.env.KNOCK_FEED_CHANNEL_KEY;

if (!SERVICE_TOKEN || !FEED_CHANNEL_KEY) {
  console.error(
    "KNOCK_SERVICE_TOKEN and KNOCK_FEED_CHANNEL_KEY are required in .env."
  );
  process.exit(1);
}

type WorkflowSpec = {
  key: string;
  name: string;
  description: string;
  category: string;
  categoryDescription: string;
  template: { markdown_body: string; action_url: string };
};

const WORKFLOWS: WorkflowSpec[] = [
  {
    key: "discussion-question-created",
    name: "Discussion Question created",
    description:
      "Someone other than the course's Instructor asked a Discussion Question on the Instructor's lesson.",
    category: "discussion-questions",
    categoryDescription:
      "Notifications about new Discussion Questions on your lessons",
    template: {
      markdown_body:
        "{{ actor.name }} asked a question on {{ data.lessonTitle }}",
      action_url: "{{ data.url }}",
    },
  },
  {
    key: "discussion-reply-created",
    name: "Discussion Reply created",
    description:
      "Someone other than the author replied to the author's Discussion Question.",
    category: "discussion-replies",
    categoryDescription:
      "Notifications about replies to your Discussion Questions",
    template: {
      markdown_body:
        "{{ actor.name }} replied to your question on {{ data.lessonTitle }}",
      action_url: "{{ data.url }}",
    },
  },
];

async function call(
  path: string,
  method: string,
  body: unknown
): Promise<{ status: number; ok: boolean; json: any }> {
  const response = await fetch(`${CONTROL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, json };
}

async function upsertCategory(spec: WorkflowSpec) {
  const { status, ok } = await call(
    `/preference_categories/${spec.category}`,
    "PUT",
    { name: spec.category, description: spec.categoryDescription }
  );
  if (!ok) throw new Error(`category ${spec.category} failed: ${status}`);
  console.log(`✓ preference category ${spec.category} (${status})`);
}

async function upsertWorkflow(spec: WorkflowSpec) {
  const workflow = {
    name: spec.name,
    description: spec.description,
    categories: [spec.category],
    steps: [
      {
        type: "channel",
        ref: "feed",
        name: "Notification Feed",
        channel_type: "in_app_feed",
        channel_key: FEED_CHANNEL_KEY,
        template: spec.template,
      },
    ],
  };
  const { status, ok, json } = await call(
    `/workflows/${spec.key}?commit=true&commit_message=notifications/59 discussion notifications`,
    "PUT",
    { workflow }
  );
  if (!ok)
    throw new Error(`workflow ${spec.key} failed: ${status} ${JSON.stringify(json)}`);
  console.log(`✓ workflow ${spec.key} committed (${status})`);
}

async function verify(spec: WorkflowSpec) {
  const response = await fetch(`${CONTROL_API}/workflows/${spec.key}`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  if (!response.ok)
    throw new Error(`verify ${spec.key} failed: ${response.status}`);
  const workflow = await response.json();
  const problems: string[] = [];
  if (!workflow.categories?.includes(spec.category))
    problems.push(`missing category ${spec.category}`);
  if (workflow.valid !== true) problems.push("not valid");
  if (workflow.sha === undefined) problems.push("no committed sha");
  if (problems.length > 0)
    throw new Error(`verify ${spec.key}: ${problems.join(", ")}`);
  console.log(
    `✓ workflow ${spec.key} verified (category ${spec.category}, committed)`
  );
}

async function main() {
  for (const spec of WORKFLOWS) {
    await upsertCategory(spec);
    await upsertWorkflow(spec);
    await verify(spec);
  }
  console.log("Discussion Notification workflows are provisioned.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
