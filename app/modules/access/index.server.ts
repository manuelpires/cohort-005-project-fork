import { db } from "~/db";
import {
  getAccess,
  requireContentAccess,
  requireInstructorOrAdmin,
  requireStaff,
  requireUserId,
  type Db,
} from "./lib/access";

export type { Access, SignedOutAccess, Viewer } from "./lib/access";

/**
 * Access bound to a database. The app uses `access`, which reads the app
 * database; tests build their own against a test database.
 */
export function createAccess(database: Db) {
  return {
    /**
     * The full snapshot for whoever is asking, without throwing — the lesson
     * page renders a paywall preview from it for visitors who can't see the
     * course.
     */
    getAccess(request: Request, courseId: number) {
      return getAccess(database, request, courseId);
    },

    /**
     * Throws 401 unless someone is signed in. Returns their user id.
     */
    requireUserId(request: Request) {
      return requireUserId(request);
    },

    /**
     * Throws 401 when signed out, 403 when the user can't see the course's
     * content. Use in actions — loader guards don't protect actions.
     */
    requireContentAccess(request: Request, courseId: number) {
      return requireContentAccess(database, request, courseId);
    },

    /**
     * Throws unless the user is the course's own instructor, or an admin.
     */
    requireStaff(request: Request, courseId: number) {
      return requireStaff(database, request, courseId);
    },

    /**
     * Throws unless the user is an instructor or an admin, without tying
     * them to a particular course — for pages that span all of someone's
     * courses.
     */
    requireInstructorOrAdmin(request: Request) {
      return requireInstructorOrAdmin(database, request);
    },
  };
}

// Pure so a route importing this only for its loader doesn't pull the
// database into the client bundle (see `~/db`).
export const access = /* @__PURE__ */ createAccess(db);
