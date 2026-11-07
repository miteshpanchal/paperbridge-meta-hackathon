export function hasUsableKey(question) {
  return Number.isInteger(question.correctIndex)
    && question.correctIndex >= 0
    && question.correctIndex < question.options.length;
}

export function isVerifiedForHosting(question) {
  return hasUsableKey(question)
    && question.sourceComplete !== false
    && question.audit?.status === "VERIFIED";
}
