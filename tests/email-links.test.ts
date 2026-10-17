import { expect, test } from 'bun:test';
import { emailLinks, linkedEmailText } from '../src/ui/email-links.ts';

test('email links preserve original text, balanced URLs and explicit safe destinations', () => {
  const body =
    'Read (https://example.com/wiki/Test_(topic)).\nAlso http://example.org/page?x=1&y=2.\nhttps://example.com/wiki/Test_(topic)';
  const links = emailLinks(body);
  expect(links.map((link) => link.url)).toEqual([
    'https://example.com/wiki/Test_(topic)',
    'http://example.org/page?x=1&y=2',
    'https://example.com/wiki/Test_(topic)',
  ]);
  const styled = linkedEmailText(body, '#aabbcc');
  expect(styled.chunks.map((chunk) => chunk.text).join('')).toBe(body);
  expect(styled.chunks.filter((chunk) => chunk.link).map((chunk) => chunk.link?.url)).toEqual(
    links.map((link) => link.url),
  );
  expect(
    emailLinks(
      'javascript:alert(1) file:///tmp/a https://localhost/x https://127.0.0.1/x https://user:pass@example.com',
    ),
  ).toEqual([]);
});
