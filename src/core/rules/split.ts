/**
 * 规则切分工具。
 *
 * 阅读（Legado）用 RuleAnalyzer 在“顶层”切规则：`&&`、`||`、`%%` 以及 CSS
 * 链里的 `@` 都不能切到 `[...]`、`(...)`、引号和转义里面。这里用一次字符扫描
 * 复刻同样的行为，规则语义见 Legado AnalyzeRule.kt / AnalyzeByJSoup.kt。
 */

export interface SplitResult {
  parts: string[];
  /** 实际命中的分隔符；没有切出多段时为 ""。 */
  type: string;
}

const DEFAULT_SEPARATORS = ['&&', '||', '%%'] as const;

/**
 * 按顶层分隔符切分。只使用最先出现的那一种分隔符（与阅读一致：
 * 一条规则里混用 && 与 || 时以先出现的为准）。
 */
export function splitTopLevel(
  rule: string,
  separators: readonly string[] = DEFAULT_SEPARATORS,
): SplitResult {
  const seps = [...separators].sort((a, b) => b.length - a.length);
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  let type = '';

  for (let i = 0; i < rule.length; i++) {
    const ch = rule[i];

    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth++;
      continue;
    }
    if (ch === ']' || ch === ')' || ch === '}') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;

    const sep = seps.find((candidate) => rule.startsWith(candidate, i));
    if (!sep) continue;

    if (!type) type = sep;
    if (type === sep) {
      parts.push(rule.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }

  parts.push(rule.slice(start));
  return {
    parts: parts.map((part) => part.trim()).filter((part) => part.length > 0),
    type: parts.length > 1 ? type : '',
  };
}

/**
 * 替换 `{$...}` 内嵌 JSONPath 规则（对应 RuleAnalyzer.innerRule）。
 * 返回 null / 空串时保留原文，避免误删用户规则。
 */
export function replaceInnerJsonRules(
  rule: string,
  resolve: (inner: string) => string | null | undefined,
): string {
  let out = '';
  let index = 0;

  while (index < rule.length) {
    const start = rule.indexOf('{$', index);
    if (start < 0) {
      out += rule.slice(index);
      break;
    }
    out += rule.slice(index, start);

    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = start; i < rule.length; i++) {
      const ch = rule[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end < 0) {
      out += rule.slice(start);
      break;
    }

    const inner = rule.slice(start + 1, end);
    const value = resolve(inner);
    out += value == null || value === '' ? rule.slice(start, end + 1) : value;
    index = end + 1;
  }

  return out;
}
