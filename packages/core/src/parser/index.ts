import type { MessageParser, ParsedMessage } from '../contracts.ts';

const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/u;
const TAG_PATTERN = /(^|\s)#([\p{L}\p{N}_]+)(?=$|[\s.,;:!?)\]}'"])/gu;
const LIST_PATTERN = /^list[^\S\n]+([^\s:]+(?:[^\S\n]+[^\s:]+){0,2})[^\S\n]*:([\s\S]*)$/iu;

/** Finds URLs and the character ranges they occupy, so tags inside them are ignored. */
function findUrls(input: string): { urls: string[]; ranges: Array<[number, number]> } {
  const urls: string[] = [];
  const ranges: Array<[number, number]> = [];
  for (const match of input.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    if (url.length === 0) continue;
    urls.push(url);
    ranges.push([match.index, match.index + match[0].length]);
  }
  return { urls, ranges };
}

function parseList(text: string): ParsedMessage['list'] {
  const match = LIST_PATTERN.exec(text);
  if (!match) return null;
  const items = (match[2] ?? '')
    .split(/[,\n]/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return null;
  return { name: (match[1] ?? '').trim(), items };
}

export const parseMessage: MessageParser = (input) => {
  const { urls, ranges } = findUrls(input);
  const inUrl = (index: number): boolean => ranges.some(([start, end]) => index >= start && index < end);

  const tags: string[] = [];
  const stripped = input.replace(TAG_PATTERN, (whole, lead: string, name: string, offset: number) => {
    if (inUrl(offset + lead.length)) return whole;
    const tag = name.toLowerCase();
    if (!tags.includes(tag)) tags.push(tag);
    return lead;
  });

  const text = stripped
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

  return { text, tags, urls, list: parseList(text) };
};
