// One-off backfill: syncs every Cadence user in the dev database to the
// notification vendor — identity (name, email, avatar) plus the default
// preference set where the user has none yet (Enrollments off, every other
// category on). Existing preference sets are never overwritten.
//
// Keyless dev syncs nothing: without KNOCK_SECRET_API_KEY the sync falls
// back to the no-op port. Run it with `npm run notifications:backfill`.
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../app/db/schema";
import { syncNotificationsUser } from "../app/lib/notifications.server";

const sqlite = new Database("data.db");
const db = drizzle(sqlite, { schema });

async function backfill() {
  const users = db.select().from(schema.users).all();
  for (const user of users) {
    // Best-effort: a failing sync is logged and swallowed inside.
    await syncNotificationsUser(user);
  }
  console.log(
    `Synced ${users.length} users to the notification vendor (any failures are logged above).`
  );
}

backfill()
  .catch(console.error)
  .finally(() => sqlite.close());
