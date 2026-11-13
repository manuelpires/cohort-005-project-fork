// PROTOTYPE — throwaway server helpers for the Notification Feed UI prototype
// (wayfinder ticket "What does the Notification Feed look like in Cadence?").
// Not production code; lives on the prototype branch only.
//
// Mirrors the vendor spike's lib: signed RS256 user tokens for the
// DevUI-selected user, plus one trigger per catalogue Notification the
// prototype fires at the current user so the feed has varied rows.
import Knock, { signUserToken } from "@knocklabs/node";

export function knockUserId(userId: number) {
  return `cadence-${userId}`;
}

let client: Knock | undefined;

export function knock() {
  if (!client) {
    const key = process.env.KNOCK_SECRET_API_KEY;
    if (!key) throw new Error("KNOCK_SECRET_API_KEY is not set");
    client = new Knock({ apiKey: key });
  }
  return client;
}

export async function signCadenceUserToken(userId: number) {
  const signingKey = process.env.KNOCK_SIGNING_KEY;
  if (!signingKey) throw new Error("KNOCK_SIGNING_KEY is not set");
  return signUserToken(knockUserId(userId), {
    signingKey,
    expiresInSeconds: 3600,
  });
}

export interface ProtoUser {
  id: number;
  name: string;
  email: string;
  avatarUrl: string | null;
}

function recipient(user: ProtoUser) {
  return {
    id: knockUserId(user.id),
    name: user.name,
    email: user.email,
    avatar_url: user.avatarUrl ?? undefined,
  };
}

function actor(user: ProtoUser) {
  return {
    id: knockUserId(user.id),
    name: user.name,
    email: user.email,
    avatar_url: user.avatarUrl ?? undefined,
  };
}

export interface FireDiscussionReplyInput {
  recipient: ProtoUser;
  replier: ProtoUser;
  courseTitle: string;
  lessonTitle: string;
  lessonUrl: string;
  questionSnippet: string;
  replySnippet: string;
}

export function fireDiscussionReply(input: FireDiscussionReplyInput) {
  return knock().workflows.trigger("discussion-reply", {
    recipients: [recipient(input.recipient)],
    actor: actor(input.replier),
    data: {
      course_title: input.courseTitle,
      lesson_title: input.lessonTitle,
      lesson_url: input.lessonUrl,
      question_snippet: input.questionSnippet,
      reply_snippet: input.replySnippet,
    },
  });
}

export interface FireDiscussionQuestionInput {
  recipient: ProtoUser;
  student: ProtoUser;
  courseTitle: string;
  lessonTitle: string;
  lessonUrl: string;
  questionSnippet: string;
}

export function fireDiscussionQuestion(input: FireDiscussionQuestionInput) {
  return knock().workflows.trigger("discussion-question", {
    recipients: [recipient(input.recipient)],
    actor: actor(input.student),
    data: {
      course_title: input.courseTitle,
      lesson_title: input.lessonTitle,
      lesson_url: input.lessonUrl,
      question_snippet: input.questionSnippet,
    },
  });
}

export interface FireNewEnrollmentInput {
  recipient: ProtoUser;
  student: ProtoUser;
  courseTitle: string;
}

export function fireNewEnrollment(input: FireNewEnrollmentInput) {
  return knock().workflows.trigger("new-enrollment", {
    recipients: [recipient(input.recipient)],
    actor: actor(input.student),
    data: {
      course_title: input.courseTitle,
      student_name: input.student.name,
    },
  });
}

export interface FireRefundApprovedInput {
  recipient: ProtoUser;
  courseTitle: string;
  amount: string;
}

export function fireRefundApproved(input: FireRefundApprovedInput) {
  return knock().workflows.trigger("refund-request-approved", {
    recipients: [recipient(input.recipient)],
    data: {
      course_title: input.courseTitle,
      refund_amount: input.amount,
    },
  });
}

export interface FireClaimedSeatInput {
  recipient: ProtoUser;
  student: ProtoUser;
  courseTitle: string;
}

export function fireClaimedSeat(input: FireClaimedSeatInput) {
  return knock().workflows.trigger("claimed-seat", {
    recipients: [recipient(input.recipient)],
    actor: actor(input.student),
    data: {
      course_title: input.courseTitle,
      student_name: input.student.name,
    },
  });
}
