import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { fileURLToPath } from "url";
import * as schema from "~/db/schema";
import { markdown } from "~/lib/text";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsFolder = path.resolve(__dirname, "../../drizzle");

const queryCounters = new WeakMap<Database.Database, { count: number }>();

/**
 * Creates a fresh in-memory SQLite database with all tables for testing.
 * Each call returns a new isolated database instance.
 *
 * Uses the same Drizzle migrations as the live database, ensuring
 * test and production schemas are always in sync.
 */
export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const testDb = drizzle(sqlite, { schema });

  migrate(testDb, { migrationsFolder });

  // The statement counter behind countQueries: one prepare is one query,
  // so a loop of queries reads as a rising count. Installed after migrate()
  // so the schema setup is never counted.
  const counter = { count: 0 };
  queryCounters.set(sqlite, counter);
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((...args: Parameters<Database.Database["prepare"]>) => {
    counter.count += 1;
    return prepare(...args);
  }) as Database.Database["prepare"];

  return testDb;
}

export type TestDb = ReturnType<typeof createTestDb>;

/**
 * Runs `run`, counting the SQL statements it prepares. The assertion the
 * caller writes against `queryCount` is a query budget: a function that
 * runs one query per row (N+1) breaks it the moment a fixture grows.
 */
export function countQueries<T>(testDb: TestDb, run: () => T) {
  const counter = queryCounters.get(testDb.$client);
  if (!counter) {
    throw new Error("countQueries needs a db from createTestDb()");
  }
  const before = counter.count;
  const result = run();
  return { result, queryCount: counter.count - before };
}

/**
 * Seeds a minimal set of base data (user, category, course) that most tests need.
 * Returns the created IDs for use in test assertions.
 */
export function seedBaseData(testDb: TestDb) {
  const user = testDb
    .insert(schema.users)
    .values({
      name: "Test User",
      email: "test@example.com",
      role: schema.UserRole.Student,
    })
    .returning()
    .get();

  const instructor = testDb
    .insert(schema.users)
    .values({
      name: "Test Instructor",
      email: "instructor@example.com",
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();

  const category = testDb
    .insert(schema.categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get();

  const course = testDb
    .insert(schema.courses)
    .values({
      title: "Test Course",
      slug: "test-course",
      description: "A test course",
      salesCopy: markdown("## Test Course\n\nSales copy for the test course."),
      instructorId: instructor.id,
      categoryId: category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();

  return { user, instructor, category, course };
}
