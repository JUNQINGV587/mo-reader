/**
 * 阅读（Legado）SourceRule 的移植：识别模式、@put、@get/{{}}、## 替换、$N 取值。
 * 对应 app/src/main/java/io/legado/app/model/analyzeRule/AnalyzeRule.kt 的
 * splitSourceRule / SourceRule。
 */

export type RuleMode = 'Default' | 'Json' | 'XPath' | 'Js' | 'Regex' | 'WebJs';

export interface SourceRuleEnv {
  /** 用同一份内容再跑一条规则（{{ 里以 @、$.、// 开头时走这里）。 */
  getStringByRule(rule: string): string;
  evalJs(script: string, result: unknown): unknown;
  getVariable(key: string): string;
}

export interface ResolvedRule {
  rule: string;
  replaceRegex: string;
  replacement: string;
  replaceFirst: boolean;
}

const GET_TYPE = -2;
const JS_TYPE = -1;
const DEFAULT_TYPE = 0;

const PUT_PATTERN = /@put:(\{[^}]+?\})/gi;
const EVAL_PATTERN = /@get:\{[^}]+?\}|\{\{[\w\W]*?\}\}/gi;
const REGEX_PARAM = /\$\d{1,2}/g;
const JS_PATTERN = /<js>([\w\W]*?)<\/js>|@js:([\w\W]*)/gi;
const WEB_JS_PATTERN = /@webjs:([\w\W]{5,})/gi;

interface RuleParam {
  type: number;
  value: string;
}

export function isRuleString(value: string): boolean {
  return (
    value.startsWith('@') ||
    value.startsWith('$.') ||
    value.startsWith('$[') ||
    value.startsWith('//')
  );
}

/** 把规则拆成“普通段 / @js 段 / @webjs 段”，与阅读 splitSourceRule 一致。 */
export function splitSourceRule(
  ruleStr: string,
  allInOne = false,
): Array<{ rule: string; mode: RuleMode }> {
  if (!ruleStr) return [];
  const segments: Array<{ rule: string; mode: RuleMode }> = [];
  let start = 0;

  // 阅读里冒号开头表示整条正则；这里保留入口，M1 先按默认处理。
  void allInOne;

  const jsRe = new RegExp(JS_PATTERN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = jsRe.exec(ruleStr))) {
    if (match.index > start) {
      const text = ruleStr.slice(start, match.index).trim();
      if (text) segments.push({ rule: text, mode: 'Default' });
    }
    segments.push({ rule: match[2] ?? match[1] ?? '', mode: 'Js' });
    start = jsRe.lastIndex;
  }

  const webRe = new RegExp(WEB_JS_PATTERN.source, 'gi');
  while ((match = webRe.exec(ruleStr))) {
    if (match.index > start) {
      const text = ruleStr.slice(start, match.index).trim();
      if (text) segments.push({ rule: text, mode: 'Default' });
    }
    segments.push({ rule: match[1] ?? '', mode: 'WebJs' });
    start = webRe.lastIndex;
  }

  if (ruleStr.length > start) {
    const text = ruleStr.slice(start).trim();
    if (text) segments.push({ rule: text, mode: 'Default' });
  }

  return segments;
}

export class SourceRule {
  readonly putMap: Record<string, string> = {};
  private readonly params: RuleParam[] = [];
  private readonly baseRule: string;
  mode: RuleMode;

  constructor(
    ruleStr: string,
    mode: RuleMode = 'Default',
    isJson = false,
  ) {
    this.mode = mode;

    if (mode === 'Js' || mode === 'Regex') {
      this.baseRule = ruleStr;
    } else if (/^@CSS:/i.test(ruleStr)) {
      this.mode = 'Default';
      this.baseRule = ruleStr;
    } else if (ruleStr.startsWith('@@')) {
      this.mode = 'Default';
      this.baseRule = ruleStr.slice(2);
    } else if (/^@XPath:/i.test(ruleStr)) {
      this.mode = 'XPath';
      this.baseRule = ruleStr.slice(7);
    } else if (/^@Json:/i.test(ruleStr)) {
      this.mode = 'Json';
      this.baseRule = ruleStr.slice(6);
    } else if (isJson || ruleStr.startsWith('$.') || ruleStr.startsWith('$[')) {
      this.mode = 'Json';
      this.baseRule = ruleStr;
    } else if (ruleStr.startsWith('/')) {
      this.mode = 'XPath';
      this.baseRule = ruleStr;
    } else {
      this.baseRule = ruleStr;
    }

    const withoutPut = this.splitPutRule(this.baseRule);
    this.parseParams(withoutPut);
  }

  getParamSize(): number {
    return this.params.length;
  }

  /** 解析出本次要跑的规则文本与 ## 替换参数（不修改自身，便于缓存后复用）。 */
  makeUpRule(result: unknown, env: SourceRuleEnv): ResolvedRule {
    let resolved: string;
    if (this.params.length === 0) {
      resolved = this.baseRule;
    } else {
      const info: string[] = [];
      for (let i = this.params.length - 1; i >= 0; i--) {
        const param = this.params[i];
        const type = param.type;
        if (type > DEFAULT_TYPE) {
          const list = Array.isArray(result) ? result : null;
          if (list) {
            if (list.length > type && list[type] != null) {
              info.unshift(String(list[type]));
            }
          } else {
            info.unshift(param.value);
          }
        } else if (type === JS_TYPE) {
          const value = isRuleString(param.value)
            ? env.getStringByRule(param.value)
            : env.evalJs(param.value, result);
          const text = formatJsValue(value);
          if (text !== null) info.unshift(text);
        } else if (type === GET_TYPE) {
          info.unshift(env.getVariable(param.value));
        } else {
          info.unshift(param.value);
        }
      }
      resolved = info.join('');
    }

    const parts = resolved.split('##');
    return {
      rule: (parts[0] ?? '').trim(),
      replaceRegex: parts[1] ?? '',
      replacement: parts[2] ?? '',
      replaceFirst: parts.length > 3,
    };
  }

  private splitPutRule(ruleStr: string): string {
    let value = ruleStr;
    const re = new RegExp(PUT_PATTERN.source, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(ruleStr))) {
      value = value.replace(match[0], '');
      try {
        const parsed = JSON.parse(match[1]) as Record<string, unknown>;
        for (const [key, item] of Object.entries(parsed)) {
          this.putMap[key] = String(item);
        }
      } catch {
        // 阅读在 @put 非法 JSON 时只记日志，这里同样忽略。
      }
    }
    return value;
  }

  private parseParams(rule: string): void {
    const evalRe = new RegExp(EVAL_PATTERN.source, 'gi');
    const matches = [...rule.matchAll(evalRe)];
    let start = 0;

    if (matches.length === 0) {
      this.splitRegex(rule);
      return;
    }

    const first = matches[0];
    const before = rule.slice(0, first.index ?? 0);
    if (
      this.mode !== 'Js' &&
      this.mode !== 'Regex' &&
      ((first.index ?? 0) === 0 || !before.includes('##'))
    ) {
      this.mode = 'Regex';
    }

    for (const match of matches) {
      const index = match.index ?? 0;
      if (index > start) this.splitRegex(rule.slice(start, index));

      const token = match[0];
      if (/^@get:/i.test(token)) {
        this.params.push({ type: GET_TYPE, value: token.slice(6, -1) });
      } else if (token.startsWith('{{')) {
        this.params.push({ type: JS_TYPE, value: token.slice(2, -2) });
      } else {
        this.splitRegex(token);
      }
      start = index + token.length;
    }

    if (rule.length > start) this.splitRegex(rule.slice(start));
  }

  private splitRegex(ruleStr: string): void {
    const arr = ruleStr.split('##');
    const first = arr[0] ?? '';
    const re = new RegExp(REGEX_PARAM.source, 'g');
    const matches = [...first.matchAll(re)];
    let start = 0;

    if (matches.length > 0 && this.mode !== 'Js' && this.mode !== 'Regex') {
      this.mode = 'Regex';
    }

    for (const match of matches) {
      const index = match.index ?? 0;
      if (index > start) {
        this.params.push({ type: DEFAULT_TYPE, value: ruleStr.slice(start, index) });
      }
      this.params.push({ type: Number(match[0].slice(1)), value: match[0] });
      start = index + match[0].length;
    }
    if (ruleStr.length > start) {
      this.params.push({ type: DEFAULT_TYPE, value: ruleStr.slice(start) });
    }
  }
}

function formatJsValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return String(value);
  return String(value);
}
