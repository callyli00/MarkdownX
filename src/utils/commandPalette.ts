/**
 * Command-palette matching.
 *
 * The palette exists so that a user who half-remembers a command name ("导出 html") never has to
 * hunt through menus. Matching therefore has to be forgiving - prefix, word start, plain substring,
 * and initials (`cbwb` for `Close the word book`) - but ranking has to stay predictable: an exact
 * prefix must always beat a keyword hit somewhere in the middle of another command.
 *
 * Pure functions on purpose: the ranking is the part worth testing, and the App only has to hand
 * over a command list and draw the result.
 */
export interface PaletteCommand {
  id: string;
  /** What the user reads and mostly types. */
  title: string;
  /** Right-aligned grey text: what the command acts on. */
  hint?: string;
  /** Extra words that should find this command (`pdf`, `latex`, `导出`). */
  keywords?: string[];
  /** Display-only acceleration hint. */
  shortcut?: string;
}

/** Text a query can be matched against, with the weight its field deserves. */
function fieldsOf(command: PaletteCommand): Array<{ text: string; weight: number }> {
  const fields: Array<{ text: string; weight: number }> = [{ text: command.title, weight: 1 }];
  if (command.hint) fields.push({ text: command.hint, weight: 0.6 });
  for (const keyword of command.keywords ?? []) fields.push({ text: keyword, weight: 0.8 });
  fields.push({ text: command.id, weight: 0.5 });
  return fields.map((field) => ({ text: field.text.toLowerCase(), weight: field.weight }));
}

/** Is every character of `needle` present in `haystack`, in order? (initials-style matching) */
function isSubsequence(haystack: string, needle: string): boolean {
  let at = 0;
  for (const ch of needle) {
    at = haystack.indexOf(ch, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}

const WORD_BREAK = /[\s·・:：/|()（）\[\]【】,，.。-]/;

/** Score one token against one field: 0 means "does not match". */
function scoreToken(text: string, token: string): number {
  if (!token) return 0;
  if (text.startsWith(token)) return 1000 - Math.min(text.length, 200);
  const at = text.indexOf(token);
  if (at === 0) return 1000;
  if (at > 0) {
    const before = text[at - 1];
    const atWordStart = WORD_BREAK.test(before);
    return atWordStart ? 700 - Math.min(at, 100) : 400 - Math.min(at, 100);
  }
  // Initials only make sense for short latin queries; for CJK they would match almost anything.
  if (/^[a-z]{2,6}$/.test(token) && isSubsequence(text, token)) return 150;
  return 0;
}

/**
 * Score a command for a whole query: every whitespace-separated token must match somewhere, so
 * "导出 pdf" narrows instead of widening. Returns 0 when the command must not be shown.
 */
export function scoreCommand(command: PaletteCommand, query: string): number {
  const tokens = String(query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return 1;

  const fields = fieldsOf(command);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      const score = scoreToken(field.text, token) * field.weight;
      if (score > best) best = score;
    }
    if (best <= 0) return 0;
    total += best;
  }
  // Shorter titles break ties: with the same score, "保存" should sit above "保存为 PDF".
  return total - Math.min(command.title.length, 60) * 0.5;
}

/** Rank the command list for `query`, keeping declaration order for equal scores. */
export function rankCommands<T extends PaletteCommand>(commands: T[], query: string, limit = 12): T[] {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) return commands.slice(0, Math.max(0, limit));

  const scored = commands.map((command, index) => ({
    command,
    index,
    score: scoreCommand(command, trimmed)
  }));
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.command);
}
