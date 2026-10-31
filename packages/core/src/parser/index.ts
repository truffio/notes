import type { MessageParser } from '../contracts.ts';

/** Placeholder until F1.1. */
export const parseMessage: MessageParser = (input) => ({ text: input.trim(), tags: [], urls: [], list: null });
