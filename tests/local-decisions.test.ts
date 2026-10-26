import { test, expect, spyOn } from 'bun:test';
import { ModelAnalyzer } from '../src/analysis.ts';
import { loadConfig } from '../src/config.ts';
import {
  DECISION_QUESTIONS,
  LOCAL_DECISION_QUESTIONS,
  parseLocalDecisions,
} from '../src/classification.ts';
import { setupFixture, testAIConnection } from '../src/onboarding.ts';
import { installedModels } from '../src/settings.ts';
import { routine } from './classification-fixtures.ts';

function decisionResponse() {
  return {
    model: 'tev1:4b',
    answers: Object.fromEntries(
      DECISION_QUESTIONS.map((q) => {
        if ('choices' in q) {
          const choice = q.name === 'source' ? 'service' : 'transactional';
          return [
            q.name,
            {
              type: 'choice',
              choice,
              confidence: 0.5,
              probabilities: Object.fromEntries(
                q.choices.map((c) => [
                  c.value,
                  c.value === choice ? 0.99 : 0.01 / (q.choices.length - 1),
                ]),
              ),
            },
          ];
        }
        return [q.name, { type: 'noul', noul: q.name === 'routine' ? 0.99 : 0.01 }];
      }),
    ),
  };
}
const config = () =>
  loadConfig(false, {
    LLM_PROVIDER: 'ollama',
    OLLAMA_CLASSIFIER: 'tev1:4b',
    OLLAMA_MODEL: 'qwen3.5:4b',
  });

test('local decision answers use chosen-label probabilities and require the entire valid rubric', () => {
  const parsed = parseLocalDecisions(decisionResponse(), 'tev1:4b');
  expect(parsed.sourceConfidence).toBe(0.99);
  expect(parsed.intentConfidence).toBe(0.99);
  expect(parsed.action).toBe(0.01);
  expect(parsed.routine).toBe(0.99);
  for (const mutate of [
    (r: any) => {
      delete r.answers.action;
    },
    (r: any) => {
      r.answers.extra = { type: 'noul', noul: 0 };
    },
    (r: any) => {
      r.model = 'other';
    },
    (r: any) => {
      r.answers.action.noul = 1.2;
    },
    (r: any) => {
      r.answers.source.type = 'refusal';
    },
    (r: any) => {
      r.answers.intent.choice = 'unknown';
    },
    (r: any) => {
      r.answers.source.probabilities = { service: 0.99 };
    },
    (r: any) => {
      r.answers.intent.probabilities.transactional = 0.3;
    },
  ]) {
    const response = decisionResponse();
    mutate(response);
    expect(() => parseLocalDecisions(response, 'tev1:4b')).toThrow();
  }
});

test('decision-capable models use one bounded local request, with metadata cached and no cloud credentials', async () => {
  const calls: { url: string; body: any; headers: any }[] = [];
  const analyzer = new ModelAnalyzer({ ...config(), apiKey: 'fictional-must-not-leave' }, (async (
    url,
    init,
  ) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers });
    return Response.json(
      String(url).endsWith('/api/show') ? { capabilities: ['decision'] } : decisionResponse(),
    );
  }) as typeof fetch);
  const m = { ...setupFixture, body: 'Paid in full. '.repeat(2000) };
  const a = await analyzer.classify(m, new AbortController().signal);
  expect(a.needsDetail).toBe(true); // A truncated email can never be auto-cleared.
  const complete = await analyzer.classify(setupFixture, new AbortController().signal);
  expect(complete.route).toBe('clear');
  expect(calls.map((c) => c.url)).toEqual([
    'http://127.0.0.1:11434/api/show',
    'http://127.0.0.1:11434/v1/systemone',
    'http://127.0.0.1:11434/v1/systemone',
  ]);
  expect(JSON.parse(calls[1].body.state).body.length).toBeLessThanOrEqual(
    config().triageChars + 200,
  );
  expect(calls[1].body.questions).toEqual(LOCAL_DECISION_QUESTIONS);
  expect(calls[1].body).not.toHaveProperty('format');
  expect(calls[1].body).not.toHaveProperty('think');
  expect(JSON.stringify(calls)).not.toContain('fictional-must-not-leave');
});

test('local decision failure never falls back to chat or another provider; regular text models still work', async () => {
  for (const kind of ['invalid', 'unavailable', 'cloud', 'text']) {
    const calls: string[] = [];
    const analyzer = new ModelAnalyzer(config(), (async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/api/show'))
        return Response.json(
          kind === 'cloud'
            ? { capabilities: ['decision'], remote_host: 'https://example.invalid' }
            : { capabilities: [kind === 'text' ? 'completion' : 'decision'] },
        );
      if (kind === 'unavailable') return new Response('', { status: 404 });
      return Response.json(
        kind === 'text'
          ? { message: { content: JSON.stringify(routine) } }
          : { model: 'tev1:4b', answers: {} },
      );
    }) as typeof fetch);
    if (kind === 'text') {
      await analyzer.classify(setupFixture, new AbortController().signal);
      expect(calls.at(-1)).toEndWith('/api/chat');
    } else {
      await expect(analyzer.classify(setupFixture, new AbortController().signal)).rejects.toThrow();
      expect(calls).toHaveLength(kind === 'cloud' ? 1 : 2);
      expect(calls.some((c) => c.endsWith('/api/chat'))).toBe(false);
    }
  }
});

test('Settings Test explains why a decision model cannot write summaries', async () => {
  const c = { ...config(), model: 'tev1:4b' };
  const analyzer = new ModelAnalyzer(c, (async (url) =>
    Response.json(
      String(url).endsWith('/api/show') ? { capabilities: ['decision'] } : decisionResponse(),
    )) as typeof fetch);
  await expect(testAIConnection(c, new AbortController().signal, analyzer)).rejects.toThrow(
    'use a text model such as Qwen',
  );
});

test('model discovery offers decision models for classification but excludes them from review and excludes cloud models', async () => {
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
    if (String(url).endsWith('/api/tags'))
      return Response.json({
        models: [
          { name: 'renamed-decision:latest' },
          { name: 'qwen3.5:4b' },
          { name: 'hosted:cloud' },
        ],
      });
    const model = JSON.parse(String(init?.body)).model;
    return Response.json({
      capabilities: [model.startsWith('renamed') ? 'decision' : 'completion'],
    });
  }) as typeof fetch);
  try {
    expect(await installedModels(config(), 'classification')).toEqual([
      'qwen3.5:4b',
      'renamed-decision:latest',
    ]);
    expect(await installedModels(config(), 'review')).toEqual(['qwen3.5:4b']);
  } finally {
    fetcher.mockRestore();
  }
});
