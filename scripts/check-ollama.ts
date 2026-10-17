// Fictional fixtures only. --openai reads credentials from .env; never fetches real mail.
import { ModelAnalyzer } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import type { Message } from '../src/domain.ts';
const config = process.argv.includes('--openai')
  ? loadConfig()
  : loadConfig(false, { LLM_PROVIDER: 'ollama', OLLAMA_MODEL: process.argv[2] || 'qwen3.5:9b' });
const analyzer = new ModelAnalyzer(config);
const fixtures = [
  {
    name: 'paid receipt',
    body: 'Payment received. Your invoice for EUR 19 is paid in full. No action is required.',
    expected: 'low',
  },
  {
    name: 'approval',
    body: 'Hi Alex, please approve the EUR 4,000 budget by tomorrow so we can start. Please reply with your decision.',
    expected: 'action',
  },
  {
    name: 'technical reading',
    body: 'This engineering newsletter explains PostgreSQL indexing. Composite indexes match the leftmost column first. EXPLAIN ANALYZE shows actual execution times and row estimates. Compare query plans before and after adding an index.',
    expected: 'reading',
  },
];
const results = [];
for (const [i, f] of fixtures.entries()) {
  const m: Message = {
    id: `test:INBOX:1:${i}`,
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
  const stages: string[] = [];
  const started = performance.now();
  try {
    const a = await analyzer.review(m, AbortSignal.timeout(150000), (s) => stages.push(s));
    const pass =
      f.expected === 'low'
        ? a.priority === 'low'
        : f.expected === 'action'
          ? !!a.action || a.requires_response
          : a.priority !== 'low';
    results.push({
      fixture: f.name,
      seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
      stages,
      priority: a.priority,
      uncertain: a.uncertain,
      pass,
    });
  } catch (error) {
    results.push({ fixture: f.name, error: String(error), pass: false });
  }
}
console.log(JSON.stringify({ provider: config.provider, model: config.model, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
