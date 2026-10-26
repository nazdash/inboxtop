import { ModelAnalyzer, ProviderFailure } from './analysis.ts';
import { configErrors, type Config } from './config.ts';
import { IMAPMailbox } from './mail.ts';
import type { Message } from './domain.ts';

export async function testMailConnection(config: Config, signal: AbortSignal) {
  if (configErrors(config).length)
    throw new Error('Enter your email address, app password and IMAP server first.');
  const mail = new IMAPMailbox(config);
  const abort = () => mail.abortConnection();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await mail.testConnection();
    signal.throwIfAborted();
  } catch {
    throw new Error(
      signal.aborted
        ? 'Connection test cancelled.'
        : 'Could not connect. Check the IMAP server, app password and provider IMAP access. TLS verification remains enabled.',
    );
  } finally {
    signal.removeEventListener('abort', abort);
    await mail.close();
  }
}
export const setupFixture: Message = {
  id: 'setup-fictional:INBOX:1:1',
  uid: 1,
  validity: '1',
  sender: 'Example Shop',
  address: 'receipts@example.invalid',
  subject: 'Fictional paid receipt',
  body: 'This is a fictional setup test. Your order of a notebook for EUR 5 has been paid in full. Nothing is due.',
  date: '2026-01-01T12:00:00Z',
  read: false,
  present: true,
  complete: true,
};
export async function testAIConnection(
  config: Config,
  signal: AbortSignal,
  analyzer = new ModelAnalyzer(config),
  progress: (stage: string) => void = () => {},
) {
  if (config.provider === 'openai' && !config.apiKey)
    throw new Error('Enter your OpenAI API key first.');
  let stage = 'Classification';
  try {
    signal.throwIfAborted();
    progress('Testing classification…');
    await analyzer.classify(setupFixture, signal);
    signal.throwIfAborted();
    stage = 'Detailed review';
    progress('Testing detailed review…');
    await analyzer.analyze(setupFixture, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw new Error('AI test cancelled.');
    if (error instanceof ProviderFailure) {
      const reason =
        error.reason === 'connection'
          ? 'cannot connect. Check the service and connection.'
          : error.reason === 'credentials'
            ? 'access denied. Check your API key and model access.'
            : error.reason === 'limit'
              ? 'provider limit reached. Check usage or billing.'
              : error.reason === 'model'
                ? stage === 'Detailed review' && error.message.includes('Decision models')
                  ? 'use a text model such as Qwen, not a decision model.'
                  : 'model unavailable. Check the selected model and service.'
                : 'provider unavailable. Try Test again later.';
      throw new Error(`${stage}: ${reason}`);
    }
    // Never echo a provider body, prompt, key or raw schema exception.
    throw new Error(`${stage}: invalid result. Retry Test or choose another model.`);
  }
}
