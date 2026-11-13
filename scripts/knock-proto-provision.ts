// PROTOTYPE — throwaway Knock provisioning for the vendor spike (wayfinder
// ticket "Does Knock hold up against Cadence?"). Lives on the prototype branch.
//
// Creates the two catalogue workflows the spike triggers, and the environment
// default preference set that makes "new Enrollment → Instructor" off by
// default (opt-in). Run after the human has created the in-app feed channel
// and a service token in the Knock dashboard:
//
//   KNOCK_FEED_CHANNEL_KEY=<key> KNOCK_SERVICE_TOKEN=<token> npx tsx scripts/knock-proto-provision.ts
//
// Idempotent: every write is an upsert, so re-run freely. MAPI writes are
// drafts until committed — after (re)running, commit so workflows are
// invokable from the app environment:
//
//   npx -y @knocklabs/cli commit -m "PROTOTYPE spike" --service-token="$KNOCK_SERVICE_TOKEN"
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
      // so the vendor template only has to carry the data.
      markdown_body: "PROTOTYPE {{ workflow.key }} for {{ recipient.name }}",
      action_url: actionUrl,
    },
  };
}

async function main() {
  const channelKey = requireEnv("KNOCK_FEED_CHANNEL_KEY");

  // 1. The feed channel must already exist (channels are dashboard-only).
  const channels = await mapi("/v1/channels?limit=50", "GET");
  console.log(`channels: ${channels.status}`);
  if (channels.status >= 300) console.log(JSON.stringify(channels.body, null, 2));
  const feedChannel = (channels.body.entries ?? []).find(
    (c: { key: string; type: string }) =>
      c.key === channelKey && c.type === "in_app_feed"
  );
  if (!feedChannel) {
    console.error(
      `No in_app_feed channel with key "${channelKey}". Found:`,
      JSON.stringify(channels.body.entries?.map((c: { key: string; type: string }) => `${c.key} (${c.type})`))
    );
    process.exit(1);
  }
  console.log(`Feed channel: ${feedChannel.id} (${feedChannel.key})`);

  // 1b. Preference categories must exist in the catalog before workflows
  //     reference them.
  for (const [key, name] of [
    ["discussions", "Discussions"],
    ["enrollments", "Enrollments"],
  ] as const) {
    const category = await mapi(`/v1/preference_categories/${key}`, "PUT", {
      name,
      description: `PROTOTYPE spike category for ${key}`,
    });
    console.log(`preference_category ${key}: ${category.status}`);
    if (category.status >= 300) console.log(JSON.stringify(category.body, null, 2));
  }

  // 2. Workflows (upsert).
  const discussionReply = await mapi("/v1/workflows/discussion-reply", "PUT", {
    workflow: {
      name: "Discussion Reply",
      description: "PROTOTYPE spike: someone replied to your Discussion Question.",
      categories: ["discussions"],
      steps: [feedStep(channelKey, "{{ data.lesson_url }}")],
    },
  });
  console.log("discussion-reply:", discussionReply.status);
  if (discussionReply.status >= 300) console.log(JSON.stringify(discussionReply.body, null, 2));

  const newEnrollment = await mapi("/v1/workflows/new-enrollment", "PUT", {
    workflow: {
      name: "New Enrollment",
      description: "PROTOTYPE spike: a Student enrolled on your course. Off by default, opt-in.",
      categories: ["enrollments"],
      steps: [feedStep(channelKey, "/courses")],
    },
  });
  console.log("new-enrollment:", newEnrollment.status);
  if (newEnrollment.status >= 300) console.log(JSON.stringify(newEnrollment.body, null, 2));

  // 3. Environment default preference set: the enrollments category is off on
  //    the in-app feed channel unless the recipient opts in.
  const defaults = await mapi("/v1/environments/development/defaults", "PUT", {
    preference_set: {
      categories: {
        enrollments: {
          channel_types: {
            in_app_feed: false,
          },
        },
      },
    },
  });
  console.log("environment defaults:", defaults.status);
  console.log(JSON.stringify(defaults.body, null, 2));

  if (
    discussionReply.status >= 300 ||
    newEnrollment.status >= 300 ||
    defaults.status >= 300
  ) {
    process.exit(1);
  }
  console.log("\nProvisioned. Trigger away.");
}

main();
