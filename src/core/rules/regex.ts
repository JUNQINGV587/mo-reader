/**
 * 阅读 AnalyzeByRegex 的移植：规则按 `&&` 串起来，最后一段取 group(1)（没有分组取整段）。
 */
export class RegexAnalyzer {
  constructor(private readonly text: string) {}

  getString(ruleStr: string): string | null {
    const list = this.getElements(ruleStr);
    return list.length > 0 ? list.join('\n') : null;
  }

  getString0(ruleStr: string): string {
    return this.getElements(ruleStr)[0] ?? '';
  }

  getElement(ruleStr: string): string | null {
    const rules = splitRegexRules(ruleStr);
    if (rules.length === 0) return null;

    let text = this.text;
    for (let i = 0; i < rules.length; i++) {
      const reg = compile(rules[i] as string, false);
      if (!reg) return null;
      if (i === rules.length - 1) {
        const match = reg.exec(text);
        if (!match) return null;
        return match[1] ?? match[0];
      }
      text = allMatches(text, rules[i] as string).join('');
    }
    return null;
  }

  getElements(ruleStr: string): string[] {
    const rules = splitRegexRules(ruleStr);
    if (rules.length === 0) return [];

    let text = this.text;
    for (let i = 0; i < rules.length; i++) {
      const values = allMatches(text, rules[i] as string);
      if (i === rules.length - 1) return values;
      text = values.join('');
    }
    return [];
  }
}

function splitRegexRules(ruleStr: string): string[] {
  return ruleStr
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean);
}

function compile(source: string, global: boolean): RegExp | null {
  try {
    return new RegExp(source, global ? 'g' : '');
  } catch {
    return null;
  }
}

function allMatches(text: string, source: string): string[] {
  const reg = compile(source, true);
  if (!reg) return [];
  const out: string[] = [];
  for (const match of text.matchAll(reg)) {
    out.push(match[1] ?? match[0]);
  }
  return out;
}
