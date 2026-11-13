// PROTOTYPE — throwaway provisioning for the Notification Feed UI prototype
// (wayfinder ticket "What does the Notification Feed look like in Cadence?").
// Not production code; lives on the prototype branch only.
//
// Upserts three extra catalogue workflows beside the two the vendor spike
// created (discussion-reply, new-enrollment), so the prototype feed has five
// row shapes to judge. Idempotent. MAPI writes are drafts until committed:
//
//   set -a; source .env; set +a
//   npx tsx scripts/proto-notifications-provision.ts
//   npx -y @knocklabs/cli commit -m "PROTOTYPE notification feed UI" --service-token="$KNOCK_SERVICE_TOKEN"
const MAPI = "https://control.knock.app";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function mapi(path: string, method: string, body?: unknown) {
  const response = await fetch(`${MAPI}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv("KNOCK_SERVICE_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  return { status: response.status, body: parsed };
}

function feedStep(channelKey: string, actionUrl: string) {
  return {
    type: "channel",
    ref: "feed",
    name: "Notification Feed",
    channel_key: channelKey,
    channel_type: "in_app_feed",
    template: {
      // Deliberately trivial: Cadence renders the Notification Feed itself,
      // so the vendor template only has to carry the action URL.
      markdown_body: "PROTOTYPE {{ workflow.key }} for {{ recipient.name }}",
      action_url: actionUrl,
    },
  };
}

async function main() {
  const channelKey = requireEnv("KNOCK_FEED_CHANNEL_KEY");

  for (const [key, name] of [
    ["refunds", "Refunds"],
    ["teams", "Teams"],
  ] as const) {
    const category = await mapi(`/v1/preference_categories/${key}`, "PUT", {
      name,
      description: `PROTOTYPE feed-UI category for ${key}`,
    });
    console.log(`preference_category ${key}: ${category.status}`);
    if (category.status >= 300) console.log(JSON.stringify(category.body, null, 2));
  }

  const workflows: [string, Record<string, unknown>][] = [
    [
      "discussion-question",
      {
        name: "Discussion Question",
        description: "PROTOTYPE: a Student asked a Discussion Question on your lesson.",
        categories: ["discussions"],
        steps: [feedStep(channelKey, "{{ data.lesson_url }}")],
      },
    ],
    [
      "refund-request-approved",
      {
        name: "Refund Request Approved",
        description: "PROTOTYPE: a buyer's Refund Request was approved.",
        categories: ["refunds"],
        steps: [feedStep(channelKey, "/settings")],
      },
    ],
    [
      "claimed-seat",
      {
        name: "Claimed Seat",
        description: "PROTOTYPE: a Student claimed a seat on your team.",
        categories: ["teams"],
        steps: [feedStep(channelKey, "/team")],
      },
    ],
  ];

  for (const [key, workflow] of workflows) {
    const result = await mapi(`/v1/workflows/${key}`, "PUT", { workflow });
    console.log(`${key}: ${result.status}`);
    if (result.status >= 300) console.log(JSON.stringify(result.body, null, 2));
  }

  console.log("Done. Now commit the drafts (see header comment).");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
