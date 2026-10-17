import { RGBA, StyledText, TextAttributes, type TextChunk } from '@opentui/core';
import { clean, safeURL } from '../domain.ts';

export function emailURL(value: string) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return;
    const check = new URL(url);
    check.protocol = 'https:';
    return safeURL(check.href) ? url.href : undefined;
  } catch {
    return;
  }
}

export function emailLinks(body: string) {
  const text = clean(body);
  const links: { start: number; text: string; url: string }[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"\u0027]+/gi)) {
    let value = match[0].replace(/[.,;:!?]+$/, '');
    // Keep balanced parentheses in URLs, excluding surrounding prose punctuation.
    while (value.endsWith(')') && value.split(')').length > value.split('(').length)
      value = value.slice(0, -1);
    const url = emailURL(value);
    if (url) links.push({ start: match.index!, text: value, url });
  }
  return links;
}

export function linkedEmailText(body: string, color: string) {
  const text = clean(body);
  const chunks: TextChunk[] = [];
  let offset = 0;
  for (const link of emailLinks(text)) {
    chunks.push({ __isChunk: true, text: text.slice(offset, link.start) });
    chunks.push({
      __isChunk: true,
      text: link.text,
      link: { url: link.url },
      fg: RGBA.fromHex(color),
      attributes: TextAttributes.UNDERLINE,
    });
    offset = link.start + link.text.length;
  }
  chunks.push({ __isChunk: true, text: text.slice(offset) });
  return new StyledText(chunks);
}
