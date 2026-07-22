/**
 * Strip Bifrost MCP agent-mode scaffolding that can leak into the assistant
 * text: a raw tool-result dump ("The Output from allowed tool calls is - {…}")
 * and pre-tool orchestration narration ("Now I shall call these tools next…").
 *
 * These are framework-injected (not model prose), so a system prompt alone
 * won't remove them. This is conservative — it only removes clearly-marked
 * scaffolding and never touches normal answer text.
 */
export function cleanReply(text: string): string {
  if (!text) return text;
  let t = stripToolDump(text);
  // Orchestration narration lines.
  t = t.replace(/^[^\S\n]*Now I shall call these tools[^\n]*\n?/gim, '');
  // Any leftover one-line dump marker with no JSON body.
  t = t.replace(/^[^\S\n]*The Output from allowed tool[^\n]*\n?/gim, '');
  return t.trim();
}

/**
 * Remove a "The Output from allowed tool… { …JSON… }" block. The JSON body can
 * be huge (the full search result), so we brace-match to its real end rather
 * than guess with a regex.
 */
function stripToolDump(text: string): string {
  const m = text.match(/The Output from allowed tool[^\n{]*/i);
  if (!m || m.index === undefined) return text;
  const open = text.indexOf('{', m.index);
  if (open === -1) {
    return text.slice(0, m.index) + text.slice(m.index + m[0].length);
  }
  const close = matchBrace(text, open);
  if (close === -1) return text; // unbalanced — leave as-is rather than mangle
  const rest = text.slice(close + 1).replace(/^\s*-?\s*/, '');
  return text.slice(0, m.index) + rest;
}

/** Index of the `}` matching the `{` at `open`, ignoring braces inside JSON strings. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
