import { ModelAnalyzer, ProviderFailure } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import { outcomeOf } from '../src/decisions.ts';
import { qualityMail } from '../tests/fixtures/quality-mail.ts';

// Opt-in, local-only evaluation. Never load a profile, .env or saved mail.
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== '--run') {
  console.log('Usage: bun scripts/evaluate-local.ts --run CLASSIFIER[,CLASSIFIER] REVIEW_MODEL');
  console.log(
    'Runs nine fictional cases per classifier locally. No downloads, cloud calls or settings changes.',
  );
  process.exit(args.length ? 1 : 0);
}
const classifiers = [...new Set(args[1].split(','))];
const review = args[2];
if (
  classifiers.length > 2 ||
  [...classifiers, review].some(
    (tag) => !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(tag) || tag.endsWith(':cloud'),
  )
) {
  throw new Error('Choose up to two installed local classifiers and one local text review model.');
}
const report: unknown[] = [];
let mismatches = 0;
for (const classifier of classifiers) {
  const config = loadConfig(false, {
    LLM_PROVIDER: 'ollama',
    OLLAMA_CLASSIFIER: classifier,
    OLLAMA_MODEL: review,
  });
  let requests = 0;
  let characters = 0;
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = new URL(String(url));
    if (address.origin !== config.ollamaURL) throw new Error('Nonlocal request blocked.');
    if (!address.pathname.endsWith('/api/show')) {
      if (requests >= 2) throw new Error('Per-case request limit reached; no additional retry.');
      requests++;
      characters += String(init?.body ?? '').length;
    }
    return fetch(url, init);
  }) as typeof fetch;
  const analyzer = new ModelAnalyzer(config, request);
  const results = [];
  for (const item of qualityMail) {
    requests = 0;
    characters = 0;
    const started = performance.now();
    let outcome: string;
    let summary = '',
      nextStep = '',
      failure = '';
    try {
      const analysis = await analyzer.review(
        structuredClone(item.message),
        AbortSignal.timeout(90000),
        () => {},
      );
      outcome = outcomeOf({ ...item.message, analysis });
      summary = analysis.takeaway;
      nextStep = analysis.action;
    } catch (error) {
      if (error instanceof ProviderFailure && requests === 0)
        throw new Error(
          'Local evaluation could not start. Check Ollama and the selected installed models; no quality score is available.',
        );
      failure = error instanceof Error ? error.message.slice(0, 300) : 'Unknown failure';
      outcome = !item.message.body && requests === 0 ? 'unavailable' : 'failed';
    }
    const result = {
      case: item.name,
      expected: item.expected,
      outcome,
      pass: outcome === item.expected,
      summary,
      nextStep,
      failure,
      requests,
      inputCharacters: characters,
      ms: Math.round(performance.now() - started),
    };
    results.push(result);
    if (!result.pass) mismatches++;
    console.log(
      `${classifier} · ${item.name}: ${outcome} (expected ${item.expected}) · ${result.ms}ms · ${requests} requests`,
    );
  }
  report.push({
    classifier,
    review,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    results,
  });
}
console.log(
  JSON.stringify(
    {
      note: 'Small fictional end-to-end category evaluation, not a real-mail accuracy estimate. Input characters include request schemas; they are not measured tokens. Review summaries manually before changing defaults.',
      report,
    },
    null,
    2,
  ),
);

process.exitCode = mismatches ? 1 : 0;
