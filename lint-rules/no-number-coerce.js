// Number() coerces silently: Number("") is 0, and an empty `lessonId` once
// opened lesson 0 for every learner. Route input — params, form data, search
// parameters — goes through a zod schema at the edge instead
// (CODING_STANDARDS.md, "Parse untrusted input with a schema, at the edge").

const isNumberCall = (callee) =>
  callee.type === "Identifier" && callee.name === "Number";

const noNumberCoerce = {
  meta: {
    type: "problem",
    messages: {
      coerced:
        'Number() coerces silently — Number("") is 0. Parse route input with a zod schema at the edge instead of coercing it by hand.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isNumberCall(node.callee)) return;
        context.report({ node, messageId: "coerced" });
      },
    };
  },
};

export default {
  meta: { name: "edge" },
  rules: { "no-number-coerce": noNumberCoerce },
};
