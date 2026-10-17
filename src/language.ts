export type AnalysisLanguage = 'en' | 'ru';
export const LANGUAGE_LABELS: Record<AnalysisLanguage, string> = {
  en: 'English',
  ru: 'Russian',
};
export function outputLanguage(language: AnalysisLanguage = 'en') {
  return `Write all generated user-facing prose in ${LANGUAGE_LABELS[language]}, regardless of the email's language. This includes summaries, actions, reasons, context, topics, facts and reading advice. Do not translate JSON keys or enum values. Keep evidence quotes and the deadline field as exact original substrings for verification; explain the deadline in the selected language in the action or summary. Preserve names, amounts, URLs and dates accurately.`;
}
