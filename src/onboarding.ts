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
) {
  if (config.provider === 'openai' && !config.apiKey)
    throw new Error('Enter your OpenAI API key first.');
  try {
    await analyzer.classify(setupFixture, signal);
    await analyzer.analyze(setupFixture, signal);
  } catch (error) {
    if (!signal.aborted && config.provider === 'ollama' && error instanceof ProviderFailure)
      throw new Error('Local model test failed. ' + error.message);
    throw new Error(
      signal.aborted
        ? 'AI test cancelled.'
        : config.provider === 'ollama'
          ? 'Local model test failed. Check the classification and review models; choose a text model for review.'
          : 'AI test failed. Check your key, billing and access to both models.',
    );
  }
}
