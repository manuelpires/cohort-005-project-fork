import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  quizAnswers,
  quizAttempts,
  quizOptions,
  quizQuestions,
  quizzes,
} from "~/db/schema";
import { z } from "zod";

export type Db = BetterSQLite3Database<typeof schema>;

/** The Lesson's Quiz as the Lesson page may show it: never which options are correct. */
export type LessonQuiz = {
  id: number;
  title: string;
  passingScore: number;
  questions: Array<{
    id: number;
    questionText: string;
    questionType: string;
    position: number;
    options: Array<{ id: number; optionText: string }>;
  }>;
};

export type QuestionResult = {
  questionId: number;
  correct: boolean;
  selectedOptionId: number | null;
  correctOptionId: number | null;
};

export type QuizAttemptResult = {
  attemptId: number;
  score: number;
  passed: boolean;
  grade: string;
  totalCorrect: number;
  totalQuestions: number;
  questionResults: QuestionResult[];
};

/** The Lesson's Quiz, or null when the Lesson has none. */
export function getQuizForLesson(db: Db, lessonId: number): LessonQuiz | null {
  const quiz = db
    .select()
    .from(quizzes)
    .where(eq(quizzes.lessonId, lessonId))
    .get();
  if (!quiz) return null;

  const questions = db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quiz.id))
    .orderBy(quizQuestions.position)
    .all();

  // One query for every question's options, grouped here — never one query
  // per question.
  const options = questions.length
    ? db
        .select({
          questionId: quizOptions.questionId,
          id: quizOptions.id,
          optionText: quizOptions.optionText,
        })
        .from(quizOptions)
        .where(
          inArray(
            quizOptions.questionId,
            questions.map((question) => question.id)
          )
        )
        .all()
    : [];
  const optionsByQuestion = new Map<
    number,
    { id: number; optionText: string }[]
  >();
  for (const option of options) {
    const own = optionsByQuestion.get(option.questionId) ?? [];
    own.push({ id: option.id, optionText: option.optionText });
    optionsByQuestion.set(option.questionId, own);
  }

  return {
    id: quiz.id,
    title: quiz.title,
    passingScore: quiz.passingScore,
    questions: questions.map((question) => ({
      ...question,
      options: optionsByQuestion.get(question.id) ?? [],
    })),
  };
}

/** The Lesson a Quiz belongs to, so an action can scope a posted quiz id. */
export function getQuizOwnerLessonId(db: Db, quizId: number): number | null {
  const quiz = db
    .select({ lessonId: quizzes.lessonId })
    .from(quizzes)
    .where(eq(quizzes.id, quizId))
    .get();
  return quiz?.lessonId ?? null;
}

const submitQuizSchema = z.object({
  intent: z.literal("submit-quiz"),
  quizId: z.coerce.number().int().positive(),
});

/** One posted answer: a `question-{id}` form field holding an option id. */
const quizAnswerSchema = z.object({
  questionId: z.coerce.number().int().positive(),
  optionId: z.coerce.number().int().positive(),
});

export type ParsedQuizSubmission =
  | { ok: true; quizId: number; selectedAnswers: Record<number, number> }
  | { ok: false };

/**
 * A submitted Quiz as the Lesson page posts it: the quiz's id, plus one
 * `question-{id}` field per answer. Malformed fields fail the parse — they
 * must not reach a query, because an empty field coerced to 0 once scored
 * against question 0.
 */
export function parseQuizSubmission(formData: FormData): ParsedQuizSubmission {
  const parsed = submitQuizSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false };

  const posted = [...formData.entries()]
    .filter(([key]) => key.startsWith("question-"))
    .map(([key, value]) => ({
      questionId: key.slice("question-".length),
      optionId: value,
    }));
  const answers = z.array(quizAnswerSchema).safeParse(posted);
  if (!answers.success) return { ok: false };

  const selectedAnswers: Record<number, number> = {};
  for (const { questionId, optionId } of answers.data) {
    selectedAnswers[questionId] = optionId;
  }
  return { ok: true, quizId: parsed.data.quizId, selectedAnswers };
}

/**
 * The Student's best attempt on the Quiz, by score. Ties go to the most
 * recent, because the row is what carries the pass.
 */
export function getBestAttempt(
  db: Db,
  userId: number,
  quizId: number
): { score: number; passed: boolean } | null {
  const best = db
    .select()
    .from(quizAttempts)
    .where(
      and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId))
    )
    .orderBy(desc(quizAttempts.score))
    .limit(1)
    .get();
  if (!best) return null;

  return { score: best.score, passed: best.passed };
}

function calculateGrade(score: number): string {
  if (score >= 0.9) return "A";
  if (score >= 0.8) return "B";
  if (score >= 0.7) return "C";
  if (score >= 0.6) return "D";
  return "F";
}

function correctOptionIds(db: Db, questionIds: number[]): Map<number, number> {
  // One query for every question's correct option — never one per question.
  const correct = questionIds.length
    ? db
        .select()
        .from(quizOptions)
        .where(
          and(
            eq(quizOptions.isCorrect, true),
            inArray(quizOptions.questionId, questionIds)
          )
        )
        .all()
    : [];
  const byQuestion = new Map<number, number>();
  for (const option of correct) {
    if (!byQuestion.has(option.questionId)) {
      byQuestion.set(option.questionId, option.id);
    }
  }
  return byQuestion;
}

/** How each question was answered and whether it counted. */
function scoreQuestions(
  db: Db,
  quizId: number,
  selectedAnswers: Record<number, number>
): { questionResults: QuestionResult[]; total: number; correct: number } {
  const questions = db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.position)
    .all();

  const correctOptionByQuestion = correctOptionIds(
    db,
    questions.map((question) => question.id)
  );

  let correct = 0;
  const questionResults: QuestionResult[] = [];

  for (const question of questions) {
    const selected = selectedAnswers[question.id];
    const correctOptionId = correctOptionByQuestion.get(question.id) ?? null;
    const isCorrect = selected === correctOptionId;

    if (isCorrect) correct++;

    questionResults.push({
      questionId: question.id,
      correct: isCorrect,
      selectedOptionId: selected ?? null,
      correctOptionId,
    });
  }

  return { questionResults, total: questions.length, correct };
}

function recordAnswers(
  db: Db,
  attemptId: number,
  questionResults: QuestionResult[]
) {
  for (const result of questionResults) {
    if (result.selectedOptionId !== null) {
      db.insert(quizAnswers)
        .values({
          attemptId,
          questionId: result.questionId,
          selectedOptionId: result.selectedOptionId,
        })
        .run();
    }
  }
}

/**
 * Scores the Student's answers and records the attempt with each answer they
 * gave. Passing takes strictly more than 70%, whatever the passing score
 * field says — that is the rule the Lesson page has always shown. Returns
 * null when the Quiz itself is gone.
 *
 * The attempt and its answers land in one transaction: an attempt whose
 * answers did not record is a state nothing knows how to read.
 */
export function submitQuizAttempt(
  db: Db,
  attempt: {
    userId: number;
    quizId: number;
    selectedAnswers: Record<number, number>;
  }
): QuizAttemptResult | null {
  const quiz = db
    .select()
    .from(quizzes)
    .where(eq(quizzes.id, attempt.quizId))
    .get();
  if (!quiz) {
    console.error("quiz not found");
    return null;
  }

  const { questionResults, total, correct } = scoreQuestions(
    db,
    attempt.quizId,
    attempt.selectedAnswers
  );

  const scoreValue = total > 0 ? correct / total : 0;
  // Passing has always taken strictly more than 70% on the Lesson page — an
  // exactly-70% score shows a C and still counts as not passed — so the rule
  // lives here and not in the Quiz's passing score field.
  const passed = scoreValue > 0.7;
  const grade = calculateGrade(scoreValue);

  const saved = db.transaction((tx) => {
    const inserted = tx
      .insert(quizAttempts)
      .values({
        userId: attempt.userId,
        quizId: attempt.quizId,
        score: scoreValue,
        passed,
      })
      .returning()
      .get();

    recordAnswers(tx, inserted.id, questionResults);
    return inserted;
  });

  return {
    attemptId: saved.id,
    score: scoreValue,
    passed,
    grade,
    totalCorrect: correct,
    totalQuestions: total,
    questionResults,
  };
}
