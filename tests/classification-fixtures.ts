import { DECISION_QUESTIONS, type ClassifierAnswers } from '../src/classification.ts';
import { DetailSchema } from '../src/analysis.ts';
export const routine: ClassifierAnswers = {
  source: 'service',
  sourceConfidence: 0.99,
  intent: 'transactional',
  intentConfidence: 0.99,
  action: 0.01,
  reply: 0.01,
  deadline: 0.01,
  reading: 0.01,
  routine: 0.99,
  uncertain: 0.01,
  newsletter: 0.01,
};
export function decisionResponse(a: ClassifierAnswers) {
  return {
    model: 'gpt-6-luna',
    answers: DECISION_QUESTIONS.map((q) => {
      if ('choices' in q) {
        const choice = a[q.name as 'source' | 'intent'];
        return {
          name: q.name,
          type: 'choice',
          choice,
          confidence: a[q.name === 'source' ? 'sourceConfidence' : 'intentConfidence'],
          probabilities: q.choices!.map((c) => ({
            value: c.value,
            probability: c.value === choice ? 1 : 0,
          })),
        };
      }
      return { name: q.name, type: 'predicate', probability: a[q.name as keyof ClassifierAnswers] };
    }),
  };
}
export const compact = (value: unknown) => DetailSchema.strip().parse(value);
export const response = (value: unknown) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify(value) }],
    },
  ],
});
