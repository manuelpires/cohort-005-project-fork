import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import {
  CheckCircle2,
  HelpCircle,
  RotateCcw,
  Trophy,
  XCircle,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import type {
  LessonQuiz,
  QuizAttemptResult,
} from "~/modules/lesson-quizzes/index.server";

export function QuizSection({
  quiz,
  bestAttempt,
  quizResult,
  quizFetcher,
  isSubmitting,
}: {
  quiz: LessonQuiz;
  bestAttempt: { score: number; passed: boolean } | null;
  quizResult: QuizAttemptResult | null;
  quizFetcher: ReturnType<typeof useFetcher>;
  isSubmitting: boolean;
}) {
  const selected = useSelectedAnswers();
  const [showQuiz, setShowQuiz] = useState(!bestAttempt?.passed);
  const [retaking, setRetaking] = useState(false);

  useQuizAnnouncement(quizResult, retaking);

  if (quizResult && !retaking) {
    return (
      <QuizResultsCard
        quiz={quiz}
        quizResult={quizResult}
        onRetake={() => {
          selected.reset();
          setRetaking(true);
        }}
      />
    );
  }

  if (!showQuiz && bestAttempt?.passed) {
    return (
      <QuizPassedBanner
        quiz={quiz}
        bestAttempt={bestAttempt}
        onRetake={() => setShowQuiz(true)}
      />
    );
  }

  return (
    <QuizForm
      quiz={quiz}
      quizFetcher={quizFetcher}
      isSubmitting={isSubmitting}
      selectedAnswers={selected.answers}
      onSelectedChange={selected.set}
      onSubmitted={() => setRetaking(false)}
    />
  );
}

/** The option a Student has picked per question while taking the quiz. */
function useSelectedAnswers() {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  return {
    answers,
    set: setAnswers,
    reset: () => setAnswers({}),
  };
}

/** Announces a fresh quiz result as a toast, once per attempt. */
function useQuizAnnouncement(
  quizResult: QuizAttemptResult | null,
  retaking: boolean
) {
  useEffect(() => {
    if (quizResult && !retaking) {
      if (quizResult.passed) {
        toast.success(
          `Quiz passed! Score: ${Math.round(quizResult.score * 100)}%`
        );
      } else {
        toast.error(
          `Quiz not passed. Score: ${Math.round(quizResult.score * 100)}%`
        );
      }
    }
  }, [quizResult, retaking]);
}

/** The icon-and-title heading the quiz cards share. */
function QuizCardHeader({ title }: { title: string }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <HelpCircle className="size-5 text-primary" />
      <h2 className="text-xl font-semibold">{title}</h2>
    </div>
  );
}

function QuizResultsCard({
  quiz,
  quizResult,
  onRetake,
}: {
  quiz: LessonQuiz;
  quizResult: QuizAttemptResult;
  onRetake: () => void;
}) {
  return (
    <Card className="mb-8">
      <CardContent className="p-6">
        <QuizCardHeader title={quiz.title} />

        <QuizResultSummary passed={quizResult.passed} quizResult={quizResult} />

        <div className="space-y-4">
          {quiz.questions.map((question, qIndex) => (
            <QuestionResultRow
              key={question.id}
              index={qIndex}
              question={question}
              result={quizResult.questionResults.find(
                (r) => r.questionId === question.id
              )}
            />
          ))}
        </div>

        {!quizResult.passed && (
          <div className="mt-6">
            <Button variant="outline" onClick={onRetake}>
              <RotateCcw className="mr-2 size-4" />
              Retake Quiz
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuizResultSummary({
  passed,
  quizResult,
}: {
  passed: boolean;
  quizResult: QuizAttemptResult;
}) {
  return (
    <div
      className={`mb-6 rounded-lg p-4 ${passed ? "bg-green-50 dark:bg-green-950" : "bg-red-50 dark:bg-red-950"}`}
    >
      <div className="flex items-center gap-3">
        {passed ? (
          <Trophy className="size-8 text-green-600" />
        ) : (
          <XCircle className="size-8 text-red-600" />
        )}
        <div>
          <p
            className={`text-lg font-semibold ${passed ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}
          >
            {passed ? "You passed!" : "Not quite — try again!"}
          </p>
          <p className="text-sm text-muted-foreground">
            Score: {quizResult.totalCorrect}/{quizResult.totalQuestions} (
            {Math.round(quizResult.score * 100)}%) — Grade: {quizResult.grade}
          </p>
        </div>
      </div>
    </div>
  );
}

function QuestionResultRow({
  index,
  question,
  result,
}: {
  index: number;
  question: LessonQuiz["questions"][number];
  result: QuizAttemptResult["questionResults"][number] | undefined;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-2 flex items-start gap-2">
        {result?.correct ? (
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-600" />
        ) : (
          <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" />
        )}
        <p className="font-medium">
          {index + 1}. {question.questionText}
        </p>
      </div>
      <div className="ml-7 space-y-1">
        {question.options.map((option) => {
          const isSelected = result?.selectedOptionId === option.id;
          const isCorrect = result?.correctOptionId === option.id;
          let className = "text-sm";
          if (isCorrect)
            className += " font-medium text-green-700 dark:text-green-400";
          else if (isSelected && !result?.correct)
            className += " text-red-600 dark:text-red-400 line-through";
          return (
            <p key={option.id} className={className}>
              {isCorrect ? "✓ " : isSelected ? "✗ " : "  "}
              {option.optionText}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function QuizPassedBanner({
  quiz,
  bestAttempt,
  onRetake,
}: {
  quiz: LessonQuiz;
  bestAttempt: { score: number; passed: boolean };
  onRetake: () => void;
}) {
  return (
    <Card className="mb-8">
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="size-5 text-green-600" />
            <span className="font-medium">{quiz.title}</span>
            <span className="text-sm text-muted-foreground">
              — Best score: {Math.round(bestAttempt.score * 100)}%
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={onRetake}>
            <RotateCcw className="mr-2 size-4" />
            Retake
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function QuizForm({
  quiz,
  quizFetcher,
  isSubmitting,
  selectedAnswers,
  onSelectedChange,
  onSubmitted,
}: {
  quiz: LessonQuiz;
  quizFetcher: ReturnType<typeof useFetcher>;
  isSubmitting: boolean;
  selectedAnswers: Record<number, number>;
  onSelectedChange: (answers: Record<number, number>) => void;
  onSubmitted: () => void;
}) {
  const allAnswered = quiz.questions.every(
    (question) => selectedAnswers[question.id] !== undefined
  );

  return (
    <Card className="mb-8">
      <CardContent className="p-6">
        <QuizCardHeader title={quiz.title} />
        <p className="mb-6 text-sm text-muted-foreground">
          Answer all questions and submit. Passing score:{" "}
          {Math.round(quiz.passingScore * 100)}%.
        </p>

        <quizFetcher.Form method="post" onSubmit={onSubmitted}>
          <input type="hidden" name="intent" value="submit-quiz" />
          <input type="hidden" name="quizId" value={quiz.id} />

          <div className="space-y-6">
            {quiz.questions.map((question, qIndex) => (
              <QuestionRadios
                key={question.id}
                index={qIndex}
                question={question}
                selectedAnswers={selectedAnswers}
                onSelectedChange={onSelectedChange}
              />
            ))}
          </div>

          <QuizSubmitRow
            isSubmitting={isSubmitting}
            allAnswered={allAnswered}
          />
        </quizFetcher.Form>
      </CardContent>
    </Card>
  );
}

function QuizSubmitRow({
  isSubmitting,
  allAnswered,
}: {
  isSubmitting: boolean;
  allAnswered: boolean;
}) {
  return (
    <div className="mt-6">
      <Button type="submit" disabled={!allAnswered || isSubmitting}>
        {isSubmitting ? "Submitting..." : "Submit Quiz"}
      </Button>
      {!allAnswered && (
        <p className="mt-2 text-sm text-muted-foreground">
          Please answer all questions before submitting.
        </p>
      )}
    </div>
  );
}

function QuestionRadios({
  index,
  question,
  selectedAnswers,
  onSelectedChange,
}: {
  index: number;
  question: LessonQuiz["questions"][number];
  selectedAnswers: Record<number, number>;
  onSelectedChange: (answers: Record<number, number>) => void;
}) {
  return (
    <div className="rounded-lg border p-4">
      <p className="mb-3 font-medium">
        {index + 1}. {question.questionText}
      </p>
      <div className="space-y-2">
        {question.options.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted"
          >
            <input
              type="radio"
              name={`question-${question.id}`}
              value={option.id}
              checked={selectedAnswers[question.id] === option.id}
              onChange={() =>
                onSelectedChange({
                  ...selectedAnswers,
                  [question.id]: option.id,
                })
              }
              className="size-4 accent-primary"
            />
            <span className="text-sm">{option.optionText}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
