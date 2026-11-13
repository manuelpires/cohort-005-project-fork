// PROTOTYPE ROUTE — throwaway Notification Feed UI prototype (wayfinder
// ticket "What does the Notification Feed look like in Cadence?"). Never
// ships; lives on the prototype branch only.
//
// Three structurally different answers to where the Notification Feed lives,
// switchable via ?variant= (A popover in sidebar / B dedicated page /
// C right drawer), all fed by the real Knock dev environment: RS256 signed
// user token for the DevUI-selected user, headless feed REST, and catalogue
// workflows fired from this route's action. Fires land for whoever is
// selected in the DevUI, regardless of the catalogue's real targeting.
import type { Route } from "./+types/prototype.notifications";
import { useSearchParams } from "react-router";
import { eq, and, isNotNull, isNull, ne, asc } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import { users, courses, modules, lessons, comments, teamMembers, UserRole } from "~/db/schema";
import { getCurrentUserId, getDevCountry } from "~/lib/session";
import { getCountryTierInfo, COUNTRIES } from "~/lib/ppp";
import { DevUI } from "~/components/dev-ui";
import { Toaster } from "sonner";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { knockUserId, signCadenceUserToken } from "~/lib/knock-feed-proto.server";
import {
  fireClaimedSeat,
  fireDiscussionQuestion,
  fireDiscussionReply,
  fireNewEnrollment,
  fireRefundApproved,
  type ProtoUser,
} from "~/lib/knock-feed-proto.server";
import { useKnockFeed } from "~/components/prototype/knock-feed";
import { ProtoSidebar } from "~/components/prototype/proto-sidebar";
import { ProtoSwitcher, type VariantKey } from "~/components/prototype/proto-switcher";
import { VariantAPopover } from "~/components/prototype/variant-a-popover";
import { VariantBPage } from "~/components/prototype/variant-b-page";
import { VariantCDrawer, VariantCLeftBell } from "~/components/prototype/variant-c-drawer";
import { useState } from "react";

function getUser(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

function toProtoUser(user: { id: number; name: string; email: string; avatarUrl: string | null } | undefined): ProtoUser | null {
  return user ? { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl } : null;
}

// Someone who isn't the current user, to be the actor.
function someoneElse(currentId: number, preferId?: number) {
  if (preferId !== undefined && preferId !== currentId) {
    const preferred = toProtoUser(getUser(preferId));
    if (preferred) return preferred;
  }
  const student = db.select().from(users).where(ne(users.id, currentId)).orderBy(asc(users.id)).get();
  return toProtoUser(student);
}

interface BackdropCourse {
  id: number;
  title: string;
  slug: string;
  coverImageUrl: string | null;
  price: number;
  instructorName: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const allUsers = db.select().from(users).all();
  const currentUserId = await getCurrentUserId(request);
  const currentUser = currentUserId ? getUser(currentUserId) : null;
  const devCountry = await getDevCountry(request);
  const countryTierInfo = getCountryTierInfo(devCountry);

  const membership = currentUser
    ? db
        .select()
        .from(teamMembers)
        .where(eq(teamMembers.userId, currentUser.id))
        .get()
    : undefined;

  const backdropCourses = db
    .select({
      id: courses.id,
      title: courses.title,
      slug: courses.slug,
      coverImageUrl: courses.coverImageUrl,
      price: courses.price,
      instructorName: users.name,
    })
    .from(courses)
    .innerJoin(users, eq(courses.instructorId, users.id))
    .orderBy(asc(courses.id))
    .limit(3)
    .all() as BackdropCourse[];

  const publicKey = process.env.KNOCK_PUBLIC_API_KEY ?? null;
  const feedChannelId = process.env.KNOCK_FEED_CHANNEL_ID ?? null;
  const signingKeyPresent = !!process.env.KNOCK_SIGNING_KEY;

  if (!currentUser || !publicKey || !feedChannelId || !signingKeyPresent) {
    return {
      ready: false as const,
      users: allUsers.map((u) => ({ id: u.id, name: u.name, role: u.role })),
      currentUser: currentUser
        ? {
            id: currentUser.id,
            name: currentUser.name,
            role: currentUser.role,
            avatarUrl: currentUser.avatarUrl ?? null,
          }
        : null,
      devCountry,
      countryTierInfo,
      countries: COUNTRIES,
    };
  }

  const token = await signCadenceUserToken(currentUser.id);

  return {
    ready: true as const,
    users: allUsers.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    currentUser: {
      id: currentUser.id,
      name: currentUser.name,
      role: currentUser.role,
      avatarUrl: currentUser.avatarUrl ?? null,
    },
    devCountry,
    countryTierInfo,
    countries: COUNTRIES,
    isTeamAdmin: !!membership,
    backdropCourses,
    knockId: knockUserId(currentUser.id),
    publicKey,
    feedChannelId,
    token,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);
  const currentUser = currentUserId ? getUser(currentUserId) : null;
  if (!currentUser) return { error: "Select a user from the DevUI panel first." };

  const recipient = toProtoUser(currentUser)!;
  const formData = await request.formData();
  const intent = String(formData.get("intent"));
  const fired: string[] = [];

  try {
    const wants = (name: string) => intent === name || intent === "fire-all";

    if (wants("fire-discussion-reply")) {
      const reply = alias(comments, "reply");
      const question = alias(comments, "question");
      const pairing = db
        .select({
          authorId: question.userId,
          replierId: reply.userId,
          lessonTitle: lessons.title,
          lessonId: lessons.id,
          courseTitle: courses.title,
          courseSlug: courses.slug,
          questionBody: question.body,
          replyBody: reply.body,
        })
        .from(reply)
        .innerJoin(question, eq(reply.parentId, question.id))
        .innerJoin(lessons, eq(reply.lessonId, lessons.id))
        .innerJoin(modules, eq(lessons.moduleId, modules.id))
        .innerJoin(courses, eq(modules.courseId, courses.id))
        .where(and(isNotNull(reply.parentId), ne(reply.userId, question.userId)))
        .get();
      const replier = pairing ? someoneElse(currentUser.id, pairing.replierId) : someoneElse(currentUser.id);
      const course = db.select().from(courses).orderBy(asc(courses.id)).get();
      if (replier && course) {
        await fireDiscussionReply({
          recipient,
          replier,
          courseTitle: pairing?.courseTitle ?? course.title,
          lessonTitle: pairing?.lessonTitle ?? "Introduction",
          lessonUrl: `/courses/${pairing?.courseSlug ?? course.slug}/lessons/${pairing?.lessonId ?? 1}`,
          questionSnippet: (pairing?.questionBody ?? "How do I structure my practice schedule?").slice(0, 120),
          replySnippet: (pairing?.replyBody ?? "Great question — start with 20 minutes a day and build up.").slice(0, 120),
        });
        fired.push("Discussion Reply");
      }
    }

    if (wants("fire-discussion-question")) {
      const question = alias(comments, "question");
      const row = db
        .select({
          authorId: question.userId,
          body: question.body,
          lessonTitle: lessons.title,
          lessonId: lessons.id,
          courseTitle: courses.title,
          courseSlug: courses.slug,
        })
        .from(question)
        .innerJoin(lessons, eq(question.lessonId, lessons.id))
        .innerJoin(modules, eq(lessons.moduleId, modules.id))
        .innerJoin(courses, eq(modules.courseId, courses.id))
        .where(isNull(question.parentId))
        .orderBy(asc(question.id))
        .get();
      const student = someoneElse(currentUser.id, row?.authorId);
      const course = db.select().from(courses).orderBy(asc(courses.id)).get();
      if (student && course) {
        await fireDiscussionQuestion({
          recipient,
          student,
          courseTitle: row?.courseTitle ?? course.title,
          lessonTitle: row?.lessonTitle ?? "Introduction",
          lessonUrl: `/courses/${row?.courseSlug ?? course.slug}/lessons/${row?.lessonId ?? 1}`,
          questionSnippet: (row?.body ?? "When should I move on from the basic exercises?").slice(0, 120),
        });
        fired.push("Discussion Question");
      }
    }

    if (wants("fire-new-enrollment")) {
      const course = db.select().from(courses).orderBy(asc(courses.id)).get();
      const student = someoneElse(currentUser.id);
      if (course && student) {
        await fireNewEnrollment({ recipient, student, courseTitle: course.title });
        fired.push("New Enrollment");
      }
    }

    if (wants("fire-refund-approved")) {
      const course = db.select().from(courses).orderBy(asc(courses.id)).get();
      if (course) {
        await fireRefundApproved({
          recipient,
          courseTitle: course.title,
          amount: (course.price / 100).toFixed(2),
        });
        fired.push("Refund Approved");
      }
    }

    if (wants("fire-claimed-seat")) {
      const course = db.select().from(courses).orderBy(asc(courses.id)).get();
      const member = db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(ne(teamMembers.userId, currentUser.id))
        .get();
      const student = someoneElse(currentUser.id, member?.userId);
      if (course && student) {
        await fireClaimedSeat({ recipient, student, courseTitle: course.title });
        fired.push("Claimed Seat");
      }
    }

    if (fired.length === 0) return { error: `Unknown or empty intent: ${intent}` };
    return { fired };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export default function PrototypeNotifications({ loaderData }: Route.ComponentProps) {
  if (!loaderData.ready) {
    return (
      <div className="flex h-screen items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold">Notification Feed prototype — not ready</h1>
          <p className="mt-2 text-muted-foreground">
            {loaderData.currentUser
              ? "KNOCK_PUBLIC_API_KEY, KNOCK_FEED_CHANNEL_ID or KNOCK_SIGNING_KEY missing from .env."
              : "Select a user from the DevUI panel, then reload."}
          </p>
        </div>
      </div>
    );
  }

  return <PrototypeApp {...loaderData} />;
}

function PrototypeApp({
  currentUser,
  users,
  devCountry,
  countryTierInfo,
  countries,
  isTeamAdmin,
  backdropCourses,
  knockId,
  publicKey,
  feedChannelId,
  token,
}: {
  currentUser: { id: number; name: string; role: UserRole; avatarUrl: string | null };
  users: { id: number; name: string; role: UserRole }[];
  devCountry: string | null;
  countryTierInfo: ReturnType<typeof getCountryTierInfo>;
  countries: typeof COUNTRIES;
  isTeamAdmin: boolean;
  backdropCourses: BackdropCourse[];
  knockId: string;
  publicKey: string;
  feedChannelId: string;
  token: string;
}) {
  const [searchParams] = useSearchParams();
  const raw = (searchParams.get("variant") ?? "A").toUpperCase();
  const variant: VariantKey = raw === "B" || raw === "C" ? raw : "A";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const feed = useKnockFeed({ publicKey, feedChannelId, knockId, token });

  return (
    <div className="flex h-screen overflow-hidden">
      {variant === "A" && (
        <ProtoSidebar currentUser={currentUser} isTeamAdmin={isTeamAdmin} bellSlot="footer">
          <VariantAPopover feed={feed} />
        </ProtoSidebar>
      )}
      {variant === "B" && (
        <ProtoSidebar
          currentUser={currentUser}
          isTeamAdmin={isTeamAdmin}
          notificationsNavCount={feed.unreadCount}
        />
      )}
      {variant === "C" && (
        <ProtoSidebar currentUser={currentUser} isTeamAdmin={isTeamAdmin} bellSlot="header">
          <VariantCLeftBell feed={feed} onOpen={() => setDrawerOpen(true)} />
        </ProtoSidebar>
      )}

      <main className="flex-1 overflow-y-auto">
        {variant === "B" ? (
          <VariantBPage feed={feed} />
        ) : (
          <Backdrop courses={backdropCourses} />
        )}
      </main>

      <VariantCDrawer
        feed={feed}
        open={variant === "C" && drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />

      <DevUI
        users={users}
        currentUser={currentUser}
        devCountry={devCountry}
        countryTierInfo={countryTierInfo}
        countries={countries}
      />
      <ProtoSwitcher variant={variant} onChange={() => setDrawerOpen(false)} feed={feed} />
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}

function Backdrop({ courses }: { courses: BackdropCourse[] }) {
  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <span className="rounded bg-purple-600 px-2 py-0.5 text-xs font-semibold uppercase text-white">
        Prototype backdrop
      </span>
      <h1 className="mt-3 text-2xl font-bold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        A stand-in dashboard, so the popover and drawer have real density to sit over. Use the
        bar at the bottom to switch variants and fire Notifications.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {courses.map((course) => (
          <Card key={course.id} className="overflow-hidden">
            {course.coverImageUrl && (
              <img src={course.coverImageUrl} alt="" className="h-32 w-full object-cover" />
            )}
            <CardHeader>
              <CardTitle className="line-clamp-1">{course.title}</CardTitle>
              <p className="text-sm text-muted-foreground">{course.instructorName}</p>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <a href={`/courses/${course.slug}`}>Continue</a>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
