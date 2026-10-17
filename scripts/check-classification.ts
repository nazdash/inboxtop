// Fictional text only. Never connects to IMAP or opens the encrypted mailbox cache.
import { ModelAnalyzer } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { CLASSIFIER_MODEL } from '../src/classification.ts';
import type { Message } from '../src/domain.ts';
const local = process.argv.includes('--ollama');
if (!local && !process.argv.includes('--openai'))
  throw new Error('Choose --openai or --ollama; this makes model calls with fictional text.');
const config = local
  ? loadConfig(false, { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: 'qwen3.5:4b' })
  : loadConfig();
if (!local && config.provider !== 'openai') throw new Error('Configured provider is not OpenAI.');
const analyzer = new ModelAnalyzer(config);
const fixtures = [
  {
    name: 'paid receipt',
    body: 'Payment received. Your invoice for EUR 19 is paid in full. No action is required.',
    expected: 'clear',
  },
  {
    name: 'budget approval',
    body: 'Hi Alex, please approve the EUR 4,000 budget by tomorrow so we can start. Please reply with your decision.',
    expected: 'act',
  },
  {
    name: 'engineering newsletter',
    body: 'This engineering newsletter explains PostgreSQL indexing. Composite indexes match the leftmost column first. EXPLAIN ANALYZE shows actual execution times and row estimates. Compare query plans before and after adding an index.',
    expected: 'read',
  },
];
const results = [];
for (const [i, f] of fixtures.entries()) {
  const message: Message = {
    id: `fictional:INBOX:1:${i}`,
    uid: i,
    validity: '1',
    subject: f.name,
    sender: i === 1 ? 'Sam' : 'Example Service',
    address: 'test@example.invalid',
    date: new Date().toISOString(),
    body: f.body,
    complete: true,
    present: true,
    read: false,
  };
  const started = performance.now();
  try {
    const classification = await analyzer.classify(message, AbortSignal.timeout(150000));
    const classifySeconds = (performance.now() - started) / 1000;
    const detailed = classification.needsDetail
      ? await analyzer.analyze({ ...message, classification }, AbortSignal.timeout(150000))
      : undefined;
    results.push({
      fixture: f.name,
      classificationSeconds: +classifySeconds.toFixed(2),
      totalSeconds: +((performance.now() - started) / 1000).toFixed(2),
      route: classification.route,
      needsDetail: classification.needsDetail,
      confidence: classification.confidence,
      signals: classification.signals,
      detailedUncertain: detailed?.uncertain,
      pass:
        classification.route === f.expected &&
        (f.expected !== 'clear' || !classification.needsDetail),
    });
  } catch (e) {
    results.push({ fixture: f.name, error: String(e), pass: false });
  }
}
console.log(
  JSON.stringify(
    {
      provider: config.provider,
      classifier: local ? config.ollamaClassifier : CLASSIFIER_MODEL,
      reviewer: config.model,
      testedAt: new Date().toISOString(),
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
