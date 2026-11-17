import { Link } from "react-router";
import type { useFetcher } from "react-router";
import { CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "~/components/ui/button";

type NeighbourLesson = { id: number; title: string } | null;

/** The Mark complete / Up next bar under the lesson body. */
export function LessonCompletionBar({
  courseSlug,
  nextLesson,
  isCompleted,
  isMarking,
  fetcher,
}: {
  courseSlug: string;
  nextLesson: NeighbourLesson;
  isCompleted: boolean;
  isMarking: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  if (isCompleted) {
    return <CompletedBar courseSlug={courseSlug} nextLesson={nextLesson} />;
  }
  return (
    <MarkCompleteForm
      nextLesson={nextLesson}
      isMarking={isMarking}
      fetcher={fetcher}
    />
  );
}

function CompletedBar({
  courseSlug,
  nextLesson,
}: {
  courseSlug: string;
  nextLesson: NeighbourLesson;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 text-green-600">
        <CheckCircle2 className="size-5" />
        <span className="font-medium">Lesson completed</span>
      </div>
      {nextLesson && (
        <Link to={`/courses/${courseSlug}/lessons/${nextLesson.id}`}>
          <Button variant="outline" size="sm">
            Up next: {nextLesson.title}
            <ChevronRight className="ml-1 size-4" />
          </Button>
        </Link>
      )}
    </div>
  );
}

function MarkCompleteForm({
  nextLesson,
  isMarking,
  fetcher,
}: {
  nextLesson: NeighbourLesson;
  isMarking: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="mark-complete" />
      <Button disabled={isMarking}>
        {isMarking ? (
          nextLesson ? (
            "Completing..."
          ) : (
            "Marking..."
          )
        ) : nextLesson ? (
          <>
            Up next: {nextLesson.title}
            <ChevronRight className="ml-1 size-4" />
          </>
        ) : (
          <>
            <CheckCircle2 className="mr-2 size-4" />
            Mark as Complete
          </>
        )}
      </Button>
    </fetcher.Form>
  );
}

/** The Previous / Next links at the very foot of the lesson page. */
export function LessonPrevNextNav({
  courseSlug,
  courseTitle,
  prevLesson,
  nextLesson,
}: {
  courseSlug: string;
  courseTitle: string;
  prevLesson: NeighbourLesson;
  nextLesson: NeighbourLesson;
}) {
  return (
    <div className="flex items-center justify-between border-t pt-6">
      {prevLesson ? (
        <LessonLink
          courseSlug={courseSlug}
          label="Previous"
          title={prevLesson.title}
          lessonId={prevLesson.id}
          leading={<ChevronLeft className="size-4" />}
        />
      ) : (
        <div />
      )}

      {nextLesson ? (
        <LessonLink
          courseSlug={courseSlug}
          label="Next"
          title={nextLesson.title}
          lessonId={nextLesson.id}
          trailing={<ChevronRight className="size-4" />}
        />
      ) : (
        <BackToCourseLink courseSlug={courseSlug} courseTitle={courseTitle} />
      )}
    </div>
  );
}

function LessonLink({
  courseSlug,
  label,
  title,
  lessonId,
  leading,
  trailing,
}: {
  courseSlug: string;
  label: string;
  title: string;
  lessonId: number;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <Link
      to={`/courses/${courseSlug}/lessons/${lessonId}`}
      className="flex items-center gap-2 text-sm hover:text-foreground text-muted-foreground"
    >
      {leading}
      <div className={trailing ? "text-right" : undefined}>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="font-medium text-foreground">{title}</div>
      </div>
      {trailing}
    </Link>
  );
}

function BackToCourseLink({
  courseSlug,
  courseTitle,
}: {
  courseSlug: string;
  courseTitle: string;
}) {
  return (
    <Link
      to={`/courses/${courseSlug}`}
      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <div>
        <div className="text-xs text-muted-foreground">Back to</div>
        <div className="font-medium text-foreground">{courseTitle}</div>
      </div>
      <ChevronRight className="size-4" />
    </Link>
  );
}
