// Provisions the Notification catalogue's workflows in the Knock
// Development environment: one committed workflow per Notification, each
// tagged with its preference category. Run with `npm run
// notifications:workflows`; safe to re-run — each workflow is upserted by
// its deterministic key and re-committed (allow_empty covers a no-change
// run).
//
// Talks to Knock's Management API (https://control.knock.app/v1), which
// authenticates with the account service token — the environment secret
// key must never be used for management. The end-to-end check at the end
// uses the secret key on the runtime API to trigger each workflow to a
// throwaway user, confirms it lands in the feed, then deletes the user.
//
// Keyless dev provisions nothing: the script exits if the tokens are
// missing from .env.
const MANAGEMENT_API = "https://control.knock.app/v1";
const RUNTIME_API = "https://api.knock.app/v1";

type WorkflowSpec = {
  key: string;
  name: string;
  description: string;
  category: string;
};

// The in-app feed step every Notification carries; Cadence writes the row
// text from the trigger's data, so the template body stays a fallback.
function feedStep(feedChannelKey: string) {
  return {
    name: "Notification Feed",
    type: "channel",
    ref: "feed",
    channel_type: "in_app_feed",
    channel_key: feedChannelKey,
    template: {
      action_url: "{{ data.url }}",
      markdown_body: "{{ workflow.name }} for {{ recipient.name }}",
    },
  };
}

// The preference categories these workflows are tagged with. They must
// exist in the project's preference category catalog before a workflow can
// reference them, so each is upserted first.
const PREFERENCE_CATEGORIES = [
  "refund-request-updates",
  "open-refund-requests",
];

const WORKFLOWS: WorkflowSpec[] = [
  {
    key: "refund-request-raised",
    name: "Refund Request Raised",
    description:
      "Confirms to the buyer their Refund Request is under review (course, amount).",
    category: "refund-request-updates",
  },
  {
    key: "refund-request-approved",
    name: "Refund Request Approved",
    description:
      "Tells the buyer their Refund Request was approved, with any decision note.",
    category: "refund-request-updates",
  },
  {
    key: "refund-request-declined",
    name: "Refund Request Declined",
    description:
      "Tells the buyer their Refund Request was declined, with the decision note.",
    category: "refund-request-updates",
  },
  {
    key: "refund-request-open",
    name: "Open Refund Request",
    description:
      "Tells every Platform Admin who asked for a refund, for which course, and why.",
    category: "open-refund-requests",
  },
];

function env(name: string): string | undefined {
  if (!process.env[name]) {
    try {
      // Vite doesn't put non-VITE_ vars on process.env, so load .env
      // ourselves.
      process.loadEnvFile(".env");
    } catch {
      return undefined;
    }
  }
  return process.env[name] || undefined;
}

async function management(
  path: string,
  serviceToken: string,
  init: RequestInit
) {
  const response = await fetch(`${MANAGEMENT_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Management API ${init.method} ${path} → ${response.status}: ${JSON.stringify(body)}`
    );
  }
  return body;
}

async function provisionWorkflow(
  spec: WorkflowSpec,
  serviceToken: string,
  feedChannelKey: string
) {
  await management(
    `/workflows/${spec.key}?environment=development&commit=true&allow_empty=true&commit_message=${encodeURIComponent(
      `Provision ${spec.key} (refund notifications)`
    )}`,
    serviceToken,
    {
      method: "PUT",
      body: JSON.stringify({
        workflow: {
          name: spec.name,
          description: spec.description,
          categories: [spec.category],
          steps: [feedStep(feedChannelKey)],
        },
      }),
    }
  );

  // GET returns the workflow at the top level; PUT wraps it in { workflow }.
  const workflow = (await management(
    `/workflows/${spec.key}?environment=development`,
    serviceToken,
    { method: "GET" }
  )) as {
    active: boolean;
    categories: string[];
    environment: string;
  };

  const committed =
    workflow.active &&
    workflow.environment === "development" &&
    workflow.categories.includes(spec.category);

  console.log(
    `${committed ? "✓" : "⚠"} ${spec.key} — categories: ${workflow.categories.join(", ")}, active: ${workflow.active}`
  );
  if (!committed) {
    throw new Error(
      `${spec.key} is not committed with category ${spec.category}`
    );
  }
}

// Fires each workflow at a throwaway user, waits for it to land in the
// feed, then deletes the user so no probe data is left behind.
async function verifyEndToEnd(secretKey: string, feedChannelId: string) {
  const probeUser = `workflow-probe-${Date.now()}`;
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
  };

  try {
    const triggered = await Promise.all(
      WORKFLOWS.map(async (spec) => {
        const response = await fetch(
          `${RUNTIME_API}/workflows/${spec.key}/trigger`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              recipients: [{ id: probeUser, name: "Workflow Probe" }],
              data: { kind: `probe-${spec.key}` },
            }),
          }
        );
        return `${spec.key}: HTTP ${response.status}`;
      })
    );
    console.log(`  trigger probe → ${triggered.join(", ")}`);

    // Feed delivery is asynchronous; poll like the prototype wizard did.
    let landed: string[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const feed = await fetch(
        `${RUNTIME_API}/users/${probeUser}/feeds/${feedChannelId}`,
        { headers }
      ).then((response) => response.json());
      landed = (feed.entries ?? []).map(
        (entry: { source: { key: string } }) => entry.source.key
      );
      if (WORKFLOWS.every((spec) => landed.includes(spec.key))) break;
    }

    const missing = WORKFLOWS.filter((spec) => !landed.includes(spec.key));
    if (missing.length > 0) {
      throw new Error(
        `Workflows did not reach the probe feed: ${missing
          .map((w) => w.key)
          .join(", ")} (landed: [${landed.join(", ")}])`
      );
    }

    console.log("  ✓ all four landed in the probe feed");
  } finally {
    await fetch(`${RUNTIME_API}/users/${probeUser}`, {
      method: "DELETE",
      headers,
    });
    console.log(`  probe user ${probeUser} deleted`);
  }
}

async function main() {
  const serviceToken = env("KNOCK_SERVICE_TOKEN");
  const secretKey = env("KNOCK_SECRET_API_KEY");
  const feedChannelKey = env("KNOCK_FEED_CHANNEL_KEY") ?? "notification-feed";
  const feedChannelId = env("KNOCK_FEED_CHANNEL_ID");

  if (!serviceToken) {
    throw new Error(
      "KNOCK_SERVICE_TOKEN missing from .env (Management API auth)"
    );
  }
  if (!secretKey || !feedChannelId) {
    throw new Error(
      "KNOCK_SECRET_API_KEY / KNOCK_FEED_CHANNEL_ID missing from .env (end-to-end check)"
    );
  }

  for (const category of PREFERENCE_CATEGORIES) {
    await management(
      `/preference_categories/${category}?environment=development`,
      serviceToken,
      { method: "PUT" }
    );
  }

  for (const spec of WORKFLOWS) {
    await provisionWorkflow(spec, serviceToken, feedChannelKey);
  }

  console.log("End-to-end check against the Development environment:");
  await verifyEndToEnd(secretKey, feedChannelId);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
