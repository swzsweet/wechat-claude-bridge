export function approvalQuestion(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const question = questions[0];
  if (typeof question?.question !== 'string' || !question.question.trim() ||
      question.multiSelect !== false || !Array.isArray(question.options) ||
      question.options.length < 2 || question.options.length > 4 ||
      question.options.some((option) => typeof option?.label !== 'string' || !option.label.trim())) return null;
  return question;
}

export function selectedAnswer(input, answer) {
  const question = approvalQuestion(input);
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    if (!question || typeof answer.other !== 'string') return null;
    const other = answer.other.trim();
    if (!other || Array.from(other).length > 500) return null;
    return { [question.question]: other };
  }
  const choice = Number(answer);
  if (!question || !Number.isInteger(choice) || choice < 1 || choice > question.options.length) return null;
  return { [question.question]: question.options[choice - 1].label };
}
