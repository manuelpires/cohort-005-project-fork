import { useState } from "react";
import { Link } from "react-router";
import { CheckCircle2, ChevronDown, Circle, PlayCircle } from "lucide-react";
import { LessonProgressStatus } from "~/db/schema";
import { cn } from "~/lib/utils";

export function CurriculumSidebar({
  course,
  curriculum,
  currentLessonId,
  lessonProgressMap,
  enrolled,
}: {
  course: { id: number; title: string; slug: string };
  curriculum: Array<{
    id: number;
    title: string;
    lessons: Array<{ id: number; title: string }>;
  }>;
  currentLessonId: number;
  lessonProgressMap: Record<number, LessonProgressStatus>;
  enrolled: boolean;
}) {
  const { expandedModules, toggleModule } = useExpandedModules(
    curriculum,
    currentLessonId
  );

  return (
    <aside className="hidden w-72 shrink-0 border-r border-border lg:block">
      <div className="sticky top-0 flex h-screen flex-col overflow-y-auto">
        <div className="border-b border-border p-4">
          <Link
            to={`/courses/${course.slug}`}
            className="text-sm font-semibold hover:text-primary"
          >
            {course.title}
          </Link>
        </div>

        <nav className="flex-1 p-2">
          {curriculum.map((mod) => (
            <ModuleSection
              key={mod.id}
              course={course}
              mod={mod}
              expanded={expandedModules.has(mod.id)}
              onToggle={() => toggleModule(mod.id)}
              currentLessonId={currentLessonId}
              lessonProgressMap={lessonProgressMap}
              enrolled={enrolled}
            />
          ))}
        </nav>
      </div>
    </aside>
  );
}

/** Which modules are expanded. The current lesson's module starts expanded. */
function useExpandedModules(
  curriculum: Array<{ id: number; lessons: Array<{ id: number }> }>,
  currentLessonId: number
) {
  const currentModuleId = curriculum.find((mod) =>
    mod.lessons.some((lesson) => lesson.id === currentLessonId)
  )?.id;

  const [expandedModules, setExpandedModules] = useState<Set<number>>(() => {
    const initial = new Set<number>();
    if (currentModuleId) initial.add(currentModuleId);
    return initial;
  });

  function toggleModule(moduleId: number) {
    setExpandedModules((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) {
        next.delete(moduleId);
      } else {
        next.add(moduleId);
      }
      return next;
    });
  }

  return { expandedModules, toggleModule };
}

function ModuleSection({
  course,
  mod,
  expanded,
  onToggle,
  currentLessonId,
  lessonProgressMap,
  enrolled,
}: {
  course: { slug: string };
  mod: {
    id: number;
    title: string;
    lessons: Array<{ id: number; title: string }>;
  };
  expanded: boolean;
  onToggle: () => void;
  currentLessonId: number;
  lessonProgressMap: Record<number, LessonProgressStatus>;
  enrolled: boolean;
}) {
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-muted"
      >
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            !expanded && "-rotate-90"
          )}
        />
        <span className="flex-1 text-left">{mod.title}</span>
      </button>

      {expanded && (
        <LessonList
          course={course}
          lessons={mod.lessons}
          currentLessonId={currentLessonId}
          lessonProgressMap={lessonProgressMap}
          enrolled={enrolled}
        />
      )}
    </div>
  );
}

function LessonList({
  course,
  lessons,
  currentLessonId,
  lessonProgressMap,
  enrolled,
}: {
  course: { slug: string };
  lessons: Array<{ id: number; title: string }>;
  currentLessonId: number;
  lessonProgressMap: Record<number, LessonProgressStatus>;
  enrolled: boolean;
}) {
  return (
    <ul className="ml-4 space-y-0.5 py-1">
      {lessons.map((lesson) => (
        <LessonLink
          key={lesson.id}
          course={course}
          lesson={lesson}
          isCurrent={lesson.id === currentLessonId}
          status={lessonProgressMap[lesson.id]}
          enrolled={enrolled}
        />
      ))}
    </ul>
  );
}

function LessonLink({
  course,
  lesson,
  isCurrent,
  status,
  enrolled,
}: {
  course: { slug: string };
  lesson: { id: number; title: string };
  isCurrent: boolean;
  status: LessonProgressStatus | undefined;
  enrolled: boolean;
}) {
  const isCompleted = status === LessonProgressStatus.Completed;
  const isInProgress = status === LessonProgressStatus.InProgress;

  return (
    <li>
      <Link
        to={`/courses/${course.slug}/lessons/${lesson.id}`}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
          isCurrent
            ? "bg-primary/10 font-medium text-primary"
            : "text-muted-foreground hover:bg-muted hover:text-foreground"
        )}
      >
        {enrolled ? (
          isCompleted ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />
          ) : isInProgress ? (
            <PlayCircle className="size-3.5 shrink-0 text-blue-500" />
          ) : (
            <Circle className="size-3.5 shrink-0" />
          )
        ) : (
          <Circle className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{lesson.title}</span>
      </Link>
    </li>
  );
}
