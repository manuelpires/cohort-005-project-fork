import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { QuestionType } from "~/db/schema";
import {
  getBestAttempt,
  getQuizForLesson,
  getQuizOwnerLessonId,
  parseQuizSubmission,
  submitQuizAttempt,
  type QuestionResult,
} from "~/modules/lesson-quizzes/index.server";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

type QuestionSpec = {
  questionText: string;
  questionType: QuestionType;
  options: Array<{ optionText: string; isCorrect?: boolean }>;
};

/** Inserts a Quiz with its questions and options, through the schema tables. */
function seedQuiz(lessonId: number, questions: QuestionSpec[]) {
  const quiz = db
    .insert(schema.quizzes)
    .values({ lessonId, title: "Check yourself", passingScore: 0.7 })
    .returning()
    .get();

  questions.forEach((spec, index) => {
    const question = db
      .insert(schema.quizQuestions)
      .values({
        quizId: quiz.id,
        questionText: spec.questionText,
        questionType: spec.questionType,
        position: index + 1,
      })
      .returning()
      .get();

    for (const option of spec.options) {
      db.insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: option.optionText,
          isCorrect: option.isCorrect ?? false,
        })
        .run();
    }
  });

  return quiz;
}

function quizQuestions(quizId: number) {
  return db
    .select()
    .from(schema.quizQuestions)
    .where(eq(schema.quizQuestions.quizId, quizId))
    .orderBy(schema.quizQuestions.position)
    .all();
}

/**
 * A ten-question quiz, so each right answer moves the score by a grade step.
 * Each question's options come back as `{ questionId: { right, wrong } }`.
 */
function seedTenQuestionQuiz(lessonId: number) {
  const specs: QuestionSpec[] = Array.from({ length: 10 }, (_, i) => ({
    questionText: `Q${i + 1}`,
    questionType: QuestionType.MultipleChoice,
    options: [
      { optionText: "Wrong" },
      { optionText: "Right", isCorrect: true },
    ],
  }));
  const quiz = seedQuiz(lessonId, specs);

  const answers: Record<number, { right: number; wrong: number }> = {};
  for (const question of quizQuestions(quiz.id)) {
    const options = db
      .select()
      .from(schema.quizOptions)
      .where(eq(schema.quizOptions.questionId, question.id))
      .all();
    const right = options.find((o) => o.isCorrect);
    const wrong = options.find((o) => !o.isCorrect);
    if (!right || !wrong) {
      throw new Error("fixture: every question needs a right and a wrong");
    }
    answers[question.id] = { right: right.id, wrong: wrong.id };
  }
  return { quizId: quiz.id, answers };
}

/** Answers the first `right` questions correctly and the rest wrongly. */
function answerTen(
  quiz: {
    quizId: number;
    answers: Record<number, { right: number; wrong: number }>;
  },
  right: number
): Record<number, number> {
  const selected: Record<number, number> = {};
  for (const [index, questionId] of Object.keys(quiz.answers).entries()) {
    const answer = quiz.answers[Number(questionId)];
    selected[Number(questionId)] = index < right ? answer.right : answer.wrong;
  }
  return selected;
}

/** Submits an attempt on the ten-question quiz with `right` correct answers. */
function attemptOn(
  quiz: {
    quizId: number;
    answers: Record<number, { right: number; wrong: number }>;
  },
  right: number
) {
  const result = submitQuizAttempt(db, {
    userId: base.user.id,
    quizId: quiz.quizId,
    selectedAnswers: answerTen(quiz, right),
  });
  if (!result) throw new Error("a scored attempt always comes back");
  return result;
}

describe("the Lesson's Quiz", () => {
  it("returns null for a Lesson without a Quiz", () => {
    expect(getQuizForLesson(db, lessonIds[0])).toBeNull();
    expect(getQuizOwnerLessonId(db, 999)).toBeNull();
  });

  it("shows the questions in position with their options, but never the correct ones", () => {
    seedQuiz(lessonIds[0], [
      {
        questionText: "Pick the right one",
        questionType: QuestionType.MultipleChoice,
        options: [
          { optionText: "Wrong" },
          { optionText: "Right", isCorrect: true },
        ],
      },
    ]);

    const quiz = getQuizForLesson(db, lessonIds[0]);
    expect(quiz).toMatchObject({
      title: "Check yourself",
      passingScore: 0.7,
      questions: [
        {
          questionText: "Pick the right one",
          position: 1,
          options: [{ optionText: "Wrong" }, { optionText: "Right" }],
        },
      ],
    });
    expect(quiz?.questions[0].options.every((o) => !("isCorrect" in o))).toBe(
      true
    );
    expect(JSON.stringify(quiz)).not.toContain("isCorrect");
  });

  it("tells the action which Lesson owns a Quiz", () => {
    const quiz = seedQuiz(lessonIds[0], []);
    expect(getQuizOwnerLessonId(db, quiz.id)).toBe(lessonIds[0]);
  });

  it("renders empty edges as empty: a quiz with no questions, a question with no options", () => {
    const questionless = seedQuiz(lessonIds[0], []);
    expect(getQuizForLesson(db, lessonIds[0])?.id).toBe(questionless.id);

    const optionless = seedQuiz(lessonIds[1], [
      {
        questionText: "No options were ever added",
        questionType: QuestionType.MultipleChoice,
        options: [],
      },
    ]);
    expect(getQuizForLesson(db, lessonIds[1])).toMatchObject({
      id: optionless.id,
      questions: [{ questionText: "No options were ever added", options: [] }],
    });
  });

  it("takes the first option marked correct when a question has two", () => {
    seedQuiz(lessonIds[0], [
      {
        questionText: "Two right answers",
        questionType: QuestionType.MultipleChoice,
        options: [
          { optionText: "First", isCorrect: true },
          { optionText: "Second", isCorrect: true },
        ],
      },
    ]);
    const quiz = getQuizForLesson(db, lessonIds[0]);
    if (!quiz) throw new Error("the quiz should exist");

    const question = quiz.questions[0];
    const firstOption = question.options[0];
    const result = submitQuizAttempt(db, {
      userId: base.user.id,
      quizId: quiz.id,
      selectedAnswers: { [question.id]: firstOption.id },
    });

    expect(result?.questionResults[0]).toMatchObject({
      correct: true,
      correctOptionId: firstOption.id,
    });
  });
});

describe("scoring an attempt", () => {
  it("returns null when the Quiz is gone", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      submitQuizAttempt(db, {
        userId: base.user.id,
        quizId: 999,
        selectedAnswers: {},
      })
    ).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("quiz not found");
    errorSpy.mockRestore();
  });

  it("scores a quiz with no questions as 0, not passed", () => {
    const empty = seedQuiz(lessonIds[0], []);

    expect(
      submitQuizAttempt(db, {
        userId: base.user.id,
        quizId: empty.id,
        selectedAnswers: {},
      })
    ).toMatchObject({
      score: 0,
      passed: false,
      grade: "F",
      totalCorrect: 0,
      totalQuestions: 0,
    });
  });

  it("scores a perfect attempt as passed with an A, and records each answer", () => {
    const quiz = seedTenQuestionQuiz(lessonIds[0]);
    const selected = answerTen(quiz, 10);

    const result = submitQuizAttempt(db, {
      userId: base.user.id,
      quizId: quiz.quizId,
      selectedAnswers: selected,
    });
    if (!result) throw new Error("a scored attempt always comes back");

    expect(result).toMatchObject({
      score: 1,
      passed: true,
      grade: "A",
      totalCorrect: 10,
      totalQuestions: 10,
    });
    expect(result.questionResults.every((q) => q.correct)).toBe(true);

    const attempts = db
      .select()
      .from(schema.quizAttempts)
      .where(eq(schema.quizAttempts.quizId, quiz.quizId))
      .all();
    expect(attempts).toHaveLength(1);
    const recorded = db
      .select()
      .from(schema.quizAnswers)
      .where(eq(schema.quizAnswers.attemptId, result.attemptId))
      .all();
    expect(recorded).toHaveLength(10);
  });

  it("passes nine of ten but not seven, and grades each step", () => {
    const quiz = seedTenQuestionQuiz(lessonIds[0]);

    expect(attemptOn(quiz, 9)).toMatchObject({
      score: 0.9,
      passed: true,
      grade: "A",
    });
    expect(attemptOn(quiz, 8)).toMatchObject({
      score: 0.8,
      passed: true,
      grade: "B",
    });
    // Strictly more than 70% passes: exactly 70% shows a C but not a pass.
    expect(attemptOn(quiz, 7)).toMatchObject({
      score: 0.7,
      passed: false,
      grade: "C",
    });
    expect(attemptOn(quiz, 6)).toMatchObject({
      score: 0.6,
      passed: false,
      grade: "D",
    });
    expect(attemptOn(quiz, 2)).toMatchObject({
      score: 0.2,
      passed: false,
      grade: "F",
    });
  });

  it("marks unanswered questions wrong and records no answer for them", () => {
    const quiz = seedQuiz(lessonIds[0], [
      {
        questionText: "Q1",
        questionType: QuestionType.MultipleChoice,
        options: [
          { optionText: "Right", isCorrect: true },
          { optionText: "Wrong" },
        ],
      },
      {
        questionText: "Q2",
        questionType: QuestionType.MultipleChoice,
        options: [
          { optionText: "Right", isCorrect: true },
          { optionText: "Wrong" },
        ],
      },
    ]);
    const questions = quizQuestions(quiz.id);
    const wrongOption = db
      .select()
      .from(schema.quizOptions)
      .where(eq(schema.quizOptions.optionText, "Wrong"))
      .all()[0];

    const result = submitQuizAttempt(db, {
      userId: base.user.id,
      quizId: quiz.id,
      selectedAnswers: { [questions[0].id]: wrongOption.id },
    });
    if (!result) throw new Error("a scored attempt always comes back");

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      grade: "F",
      totalCorrect: 0,
      totalQuestions: 2,
    });
    expect(
      result.questionResults.map((q: QuestionResult) => q.selectedOptionId)
    ).toEqual([wrongOption.id, null]);
  });

  it("keeps the best attempt: the highest score wins across attempts", () => {
    const quiz = seedTenQuestionQuiz(lessonIds[1]);
    attemptOn(quiz, 8);
    attemptOn(quiz, 5);
    attemptOn(quiz, 9);

    expect(getBestAttempt(db, base.user.id, quiz.quizId)).toMatchObject({
      score: 0.9,
      passed: true,
    });
  });

  it("returns null when the Student has never attempted the Quiz", () => {
    const quiz = seedTenQuestionQuiz(lessonIds[1]);
    expect(getBestAttempt(db, base.user.id, quiz.quizId)).toBeNull();
  });
});

describe("parsing a submitted quiz", () => {
  it("reads the quiz id and each question-{id} answer field", () => {
    const formData = new FormData();
    formData.set("intent", "submit-quiz");
    formData.set("quizId", "7");
    formData.set("question-11", "3");
    formData.set("question-12", "4");

    expect(parseQuizSubmission(formData)).toEqual({
      ok: true,
      quizId: 7,
      selectedAnswers: { 11: 3, 12: 4 },
    });
  });

  it("rejects an empty quiz id instead of coercing it to 0", () => {
    const formData = new FormData();
    formData.set("intent", "submit-quiz");
    formData.set("quizId", "");

    expect(parseQuizSubmission(formData)).toEqual({ ok: false });
  });

  it("rejects a malformed answer field instead of scoring it", () => {
    const formData = new FormData();
    formData.set("intent", "submit-quiz");
    formData.set("quizId", "7");
    formData.set("question-", "3");

    expect(parseQuizSubmission(formData)).toEqual({ ok: false });
  });
});
