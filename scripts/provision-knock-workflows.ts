// Idempotent provisioning of the Notification workflows in Knock's
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

type WorkflowDefinition = {
  key: string;
  name: string;
  description: string;
  category: string;
  markdownBody: string;
};

const WORKFLOWS: WorkflowDefinition[] = [
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

async function provision(
  token: string,
  channelKey: string,
  workflow: WorkflowDefinition
) {
  // A workflow's category must already exist in the project's preference
  // category catalog; upserting by name is idempotent.
  await management(token, `/preference_categories/${workflow.category}`, {
    method: "PUT",
  });

  const workflowBody = {
    name: workflow.name,
    description: workflow.description,
    categories: [workflow.category],
    steps: [
      {
        name: "Notification Feed",
        type: "channel",
        ref: "feed",
        channel_type: "in_app_feed",
        channel_key: channelKey,
        template: {
          action_url: "{{ data.url }}",
          markdown_body: workflow.markdownBody,
        },
      },
    ],
    trigger_frequency: "every_trigger",
  };

  const query = new URLSearchParams({
    environment: ENVIRONMENT,
    commit: "true",
    commit_message: `Provision ${workflow.key} (notifications #60)`,
    allow_empty: "true",
  });
  await management(token, `/workflows/${workflow.key}?${query}`, {
    method: "PUT",
    body: JSON.stringify({ workflow: workflowBody }),
  });

  const verified = await management(
    token,
    `/workflows/${workflow.key}?environment=${ENVIRONMENT}`
  );
  const active = verified.active === true;
  const categories = verified.categories as string[] | undefined;
  if (!active || !categories?.includes(workflow.category)) {
    throw new Error(
      `${workflow.key} is not ready: active=${active} categories=${JSON.stringify(categories)}`
    );
  }
  console.log(
    `${workflow.key}: committed, active, category "${workflow.category}".`
  );
}

async function main() {
  const token = serviceToken();
  const channelKey = feedChannelKey();
  for (const workflow of WORKFLOWS) {
    await provision(token, channelKey, workflow);
  }
  console.log("Notification workflows provisioned.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
