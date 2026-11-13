import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  fakeNotifications,
  type NotificationsPort,
} from "~/lib/notifications.server";
import {
  createComment,
  deleteComment,
  getCommentById,
} from "./comments.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let notifications: ReturnType<typeof fakeNotifications>;
let lessonId: number;
let otherLessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  notifications = fakeNotifications();

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  const lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
  lessonId = lessonIds[0];
  otherLessonId = lessonIds[1];
});

function addUser(name: string, role: schema.UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase().replace(/ /g, "-")}@example.dev`, role })
    .returning()
    .get();
}

describe("creating a comment", () => {
  it("creates a Discussion Question with a trimmed body", async () => {
    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "  Is this the right lesson?  ",
      NOW,
      notifications
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.comment).toMatchObject({
      userId: base.user.id,
      lessonId,
      parentId: null,
      body: "Is this the right lesson?",
      createdAt: NOW.toISOString(),
    });
    expect(result.course).toMatchObject({
      courseId: base.course.id,
      courseTitle: base.course.title,
      courseSlug: base.course.slug,
      instructorId: base.instructor.id,
    });
    expect(result.parentAuthorId).toBe(null);
    expect(getCommentById(db, result.comment.id)?.body).toBe(
      "Is this the right lesson?"
    );
  });

  it("rejects an empty comment", async () => {
    const result = await createComment(db, base.user.id, lessonId, null, "   ", NOW, notifications);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment cannot be empty",
    });
  });

  it("rejects a comment over the length limit", async () => {
    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "a".repeat(5001),
      NOW,
      notifications
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Comment must be 5000 characters or fewer",
    });
  });

  it("rejects a lesson that belongs to no course", async () => {
    const result = await createComment(
      db,
      base.user.id,
      lessonId + 1000,
      null,
      "Hi",
      NOW,
      notifications
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Lesson not found",
    });
  });

  it("creates a Discussion Reply and reports the question's author", async () => {
    const question = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);

    const result = await createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Start at the top.",
      NOW,
      notifications
    );

    if (!result.ok) throw new Error(result.error);

    expect(result.comment).toMatchObject({
      userId: base.instructor.id,
      lessonId,
      parentId: question.comment.id,
      body: "Start at the top.",
    });
    expect(result.parentAuthorId).toBe(base.user.id);
  });

  it("rejects a reply to a comment that doesn't exist", async () => {
    const result = await createComment(db, base.user.id, lessonId, 9999, "Hi", NOW, notifications);

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Parent comment not found",
    });
  });

  it("rejects a reply to a comment on another lesson", async () => {
    const question = await createComment(
      db,
      base.user.id,
      otherLessonId,
      null,
      "Question elsewhere",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);

    const result = await createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Wrong thread",
      NOW,
      notifications
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      error: "Parent comment belongs to a different lesson",
    });
  });

  it("rejects a reply to a reply", async () => {
    const question = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);
    const reply = await createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Start at the top.",
      NOW,
      notifications
    );
    if (!reply.ok) throw new Error(reply.error);

    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      reply.comment.id,
      "But what about...",
      NOW,
      notifications
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: "Replies can only be one level deep",
    });
  });
});

describe("notifying about a new comment", () => {
  it("notifies the course's Instructor when a Student asks a Discussion Question", async () => {
    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toHaveLength(1);
    const trigger = notifications.triggers[0];
    expect(trigger.workflow).toBe("discussion-question-created");
    expect(trigger.recipients).toEqual([
      expect.objectContaining({ id: base.instructor.id }),
    ]);
    expect(trigger.actor).toMatchObject({ id: base.user.id });
    expect(trigger.idempotencyKey).toBe(
      `discussion-question-created:${result.comment.id}`
    );
    expect(trigger.data).toMatchObject({
      kind: "discussion-question",
      commentId: result.comment.id,
      lessonTitle: "Lesson 1",
      snippet: "How do I start?",
      url: `/courses/${base.course.slug}/lessons/${lessonId}#comment-${result.comment.id}`,
    });
  });

  it("notifies the Instructor when a Platform Admin asks a Discussion Question", async () => {
    const admin = addUser("Admin User", schema.UserRole.Admin);

    const result = await createComment(
      db,
      admin.id,
      lessonId,
      null,
      "A question from staff",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.triggers[0]).toMatchObject({
      workflow: "discussion-question-created",
      recipients: [expect.objectContaining({ id: base.instructor.id })],
      actor: expect.objectContaining({ id: admin.id }),
    });
  });

  it("never notifies the Instructor about their own question", async () => {
    const result = await createComment(
      db,
      base.instructor.id,
      lessonId,
      null,
      "A note from the Instructor",
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers).toHaveLength(0);
  });

  it("notifies the question's author, and only the author, when someone else replies", async () => {
    const otherStudent = addUser("Other Student", schema.UserRole.Student);
    const question = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);

    const instructorReply = await createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Start at the top.",
      NOW,
      notifications
    );
    if (!instructorReply.ok) throw new Error(instructorReply.error);

    const otherReply = await createComment(
      db,
      otherStudent.id,
      lessonId,
      question.comment.id,
      "I was wondering too.",
      NOW,
      notifications
    );
    if (!otherReply.ok) throw new Error(otherReply.error);

    // Only the question trigger and the two reply triggers — the Instructor
    // hears about the question, the author about both replies, nobody else.
    expect(notifications.triggers).toHaveLength(3);
    for (const trigger of notifications.triggers.slice(1)) {
      expect(trigger.workflow).toBe("discussion-reply-created");
      expect(trigger.recipients).toEqual([
        expect.objectContaining({ id: base.user.id }),
      ]);
    }
    expect(notifications.triggers[1]).toMatchObject({
      actor: expect.objectContaining({ id: base.instructor.id }),
      idempotencyKey: `discussion-reply-created:${instructorReply.comment.id}`,
      data: {
        kind: "discussion-reply",
        commentId: instructorReply.comment.id,
        lessonTitle: "Lesson 1",
        snippet: "Start at the top.",
        url: `/courses/${base.course.slug}/lessons/${lessonId}#comment-${instructorReply.comment.id}`,
      },
    });
  });

  it("never notifies the author about their own reply", async () => {
    const question = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);

    const reply = await createComment(
      db,
      base.user.id,
      lessonId,
      question.comment.id,
      "Never mind, figured it out.",
      NOW,
      notifications
    );
    if (!reply.ok) throw new Error(reply.error);

    // Only the question's Notification to the Instructor survives.
    expect(notifications.triggers).toHaveLength(1);
    expect(notifications.triggers[0].workflow).toBe(
      "discussion-question-created"
    );
  });

  it("keeps a long comment's snippet to 80 characters", async () => {
    const body = "a".repeat(200);
    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      body,
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.triggers[0].data.snippet).toBe("a".repeat(80));
  });
});

describe("archiving Notifications on comment deletion", () => {
  async function seedQuestionWithReply() {
    const question = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);
    const reply = await createComment(
      db,
      base.instructor.id,
      lessonId,
      question.comment.id,
      "Start at the top.",
      NOW,
      notifications
    );
    if (!reply.ok) throw new Error(reply.error);
    return { question, reply };
  }

  it("archives the Question Notification when a Discussion Question is soft-deleted, and keeps the Reply Notifications", async () => {
    const { question } = await seedQuestionWithReply();
    // Both feeds start populated: the Instructor's question row, the
    // author's reply row.
    expect(notifications.messagesFor(base.instructor.id)).toHaveLength(1);
    expect(notifications.messagesFor(base.user.id)).toHaveLength(1);

    const result = await deleteComment(
      db,
      question.comment.id,
      base.user.id,
      false,
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    // The Instructor's feed loses the question; the author keeps the reply
    // because the reply itself stays visible under the deleted question.
    expect(notifications.messagesFor(base.instructor.id)).toHaveLength(0);
    expect(notifications.messagesFor(base.user.id)).toHaveLength(1);
    expect(getCommentById(db, question.comment.id)?.deletedAt).toBe(
      NOW.toISOString()
    );
  });

  it("archives the Reply Notification when a Discussion Reply is deleted, and keeps the Question Notification", async () => {
    const { question, reply } = await seedQuestionWithReply();

    const result = await deleteComment(
      db,
      reply.comment.id,
      base.instructor.id,
      false,
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(notifications.messagesFor(base.user.id)).toHaveLength(0);
    expect(notifications.messagesFor(base.instructor.id)).toHaveLength(1);
    expect(getCommentById(db, question.comment.id)?.deletedAt).toBeNull();
  });

  it("lets staff delete someone else's comment and archive its Notifications", async () => {
    const { question } = await seedQuestionWithReply();

    const result = await deleteComment(
      db,
      question.comment.id,
      base.instructor.id,
      true,
      NOW,
      notifications
    );
    if (!result.ok) throw new Error(result.error);

    expect(getCommentById(db, question.comment.id)?.deletedAt).toBe(
      NOW.toISOString()
    );
    expect(notifications.messagesFor(base.instructor.id)).toHaveLength(0);
  });

  it("rejects deletion by someone who is neither the author nor staff, leaving Notifications alone", async () => {
    const { question } = await seedQuestionWithReply();
    const bystander = addUser("Bystander", schema.UserRole.Student);

    const result = await deleteComment(
      db,
      question.comment.id,
      bystander.id,
      false,
      NOW,
      notifications
    );

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(getCommentById(db, question.comment.id)?.deletedAt).toBeNull();
    expect(notifications.messagesFor(base.instructor.id)).toHaveLength(1);
  });

  it("rejects deleting a comment that does not exist", async () => {
    const result = await deleteComment(
      db,
      9999,
      base.user.id,
      false,
      NOW,
      notifications
    );

    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("stays idempotent when the comment is already deleted", async () => {
    const { question } = await seedQuestionWithReply();
    const first = await deleteComment(
      db,
      question.comment.id,
      base.user.id,
      false,
      NOW,
      notifications
    );
    if (!first.ok) throw new Error(first.error);

    const second = await deleteComment(
      db,
      question.comment.id,
      base.user.id,
      false,
      new Date(2026, 9, 7, 12, 0, 0),
      notifications
    );

    expect(second.ok).toBe(true);
    expect(getCommentById(db, question.comment.id)?.deletedAt).toBe(
      NOW.toISOString()
    );
  });
});

describe("triggers being best-effort", () => {
  function throwingPort(): NotificationsPort {
    return {
      async identifyUser() {
        throw new Error("Knock is down");
      },
      async getPreferences() {
        throw new Error("Knock is down");
      },
      async setPreferences() {
        throw new Error("Knock is down");
      },
      async trigger() {
        throw new Error("Knock is down");
      },
      async archiveCommentNotifications() {
        throw new Error("Knock is down");
      },
    };
  }

  it("a failing trigger never fails the comment creation", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      throwingPort()
    );

    expect(result.ok).toBe(true);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("a failing archive never fails the comment deletion", async () => {
    const question = await createComment(
      db,
      base.user.id,
      lessonId,
      null,
      "How do I start?",
      NOW,
      notifications
    );
    if (!question.ok) throw new Error(question.error);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await deleteComment(
      db,
      question.comment.id,
      base.user.id,
      false,
      NOW,
      throwingPort()
    );

    expect(result.ok).toBe(true);
    expect(getCommentById(db, question.comment.id)?.deletedAt).toBe(
      NOW.toISOString()
    );
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
