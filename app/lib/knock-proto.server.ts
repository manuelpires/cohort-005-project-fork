// PROTOTYPE — throwaway Knock vendor spike (wayfinder ticket "Does Knock hold
// up against Cadence?"). Not production code; lives on the prototype branch only.
//
// Wraps the three server-side things the spike needs:
// 1. signing RS256 user tokens for the DevUI-selected user (check 1),
// 2. triggering catalogue workflows with inline recipient identification (check 2),
// 3. reading feed/preferences state server-side for comparison with the client path (checks 3+4).
import Knock, { signUserToken } from "@knocklabs/node";

// Knock user ids are strings; ours are integers. Prefix to keep the vendor's
// id space separate from anything else we ever point at it.
export function knockUserId(userId: number) {
  return `cadence-${userId}`;
}

let client: Knock | undefined;

export function knock() {
  if (!client) {
    const key = process.env.KNOCK_SECRET_API_KEY;
    if (!key) throw new Error("KNOCK_SECRET_API_KEY is not set (run the Knock setup wizard)");
    client = new Knock({ apiKey: key });
  }
  return client;
}

// Check 1: our server signs an RS256 token for the session's user; the browser
// uses it (with the public key) to read and act on that user's feed.
export async function signCadenceUserToken(userId: number) {
  const signingKey = process.env.KNOCK_SIGNING_KEY;
  if (!signingKey) throw new Error("KNOCK_SIGNING_KEY is not set (run the Knock setup wizard)");
  return signUserToken(knockUserId(userId), {
    signingKey,
    expiresInSeconds: 3600,
  });
}

export interface TriggerDiscussionReplyInput {
  questionAuthor: { id: number; name: string; email: string; avatarUrl: string | null };
  replier: { id: number; name: string; email: string };
  courseTitle: string;
  lessonTitle: string;
  questionSnippet: string;
  replySnippet: string;
  lessonUrl: string;
}

// Check 2: trigger the real catalogue Notification "Discussion Reply → question
// author". Recipient + actor are inline-identified so Knock creates them.
export async function triggerDiscussionReply(input: TriggerDiscussionReplyInput) {
  return knock().workflows.trigger("discussion-reply", {
    recipients: [
      {
        id: knockUserId(input.questionAuthor.id),
        name: input.questionAuthor.name,
        email: input.questionAuthor.email,
        avatar_url: input.questionAuthor.avatarUrl ?? undefined,
      },
    ],
    actor: {
      id: knockUserId(input.replier.id),
      name: input.replier.name,
      email: input.replier.email,
    },
    data: {
      course_title: input.courseTitle,
      lesson_title: input.lessonTitle,
      question_snippet: input.questionSnippet,
      reply_snippet: input.replySnippet,
      lesson_url: input.lessonUrl,
    },
  });
}

export interface TriggerNewEnrollmentInput {
  instructor: { id: number; name: string; email: string };
  student: { id: number; name: string; email: string };
  courseTitle: string;
}

// Check 4's companion trigger: "new Enrollment → Instructor", the Notification
// that must be off by default and opt-in.
export async function triggerNewEnrollment(input: TriggerNewEnrollmentInput) {
  return knock().workflows.trigger("new-enrollment", {
    recipients: [
      {
        id: knockUserId(input.instructor.id),
        name: input.instructor.name,
        email: input.instructor.email,
      },
    ],
    actor: {
      id: knockUserId(input.student.id),
      name: input.student.name,
      email: input.student.email,
    },
    data: {
      course_title: input.courseTitle,
      student_name: input.student.name,
    },
  });
}
