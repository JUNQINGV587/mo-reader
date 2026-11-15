/**
 * 阅读（Legado）AnalyzeRule 的移植：把一条书源规则作用到内容上。
 *
 * - 先按 `@js:` / `<js>` / `@webjs:` 把规则拆段（splitSourceRule）
 * - 每段识别模式（Default/Json/XPath/Js/Regex/WebJs），@put / {{}} / $N 由 SourceRule 解析
 * - Default/Json/XPath 内容分析器内部再处理 `&&` / `||` / `%%`
 * - `##` 替换、HTML 实体反转义、相对 URL 补全、@get/@put 变量
 */
import { HtmlNode, JsoupAnalyzer } from './jsoup.js';
import { JsonPathAnalyzer, stringify } from './jsonpath.js';
import { XPathAnalyzer } from './xpath.js';
import { RegexAnalyzer } from './regex.js';
import { evalJs } from './js.js';
import {
  isRuleString,
  SourceRule,
  splitSourceRule,
  type ResolvedRule,
  type RuleMode,
  type SourceRuleEnv,
} from './source-rule.js';

export interface AnalyzeOptions {
  baseUrl?: string;
  redirectUrl?: string;
  book?: unknown;
  chapter?: unknown;
  source?: unknown;
  variables?: Record<string, string>;
}

export class AnalyzeRule {
  content: unknown;
  baseUrl: string;

  private readonly redirectUrl: string;
  private readonly book: unknown;
  private readonly chapter: unknown;
  private readonly source: unknown;
  private readonly variables = new Map<string, string>();

  private readonly env: SourceRuleEnv = {
    getStringByRule: (rule: string) => this.getString(rule),
    evalJs: (script: string, result: unknown) => this.evalJs(script, result),
    getVariable: (key: string) => this.getVariable(key),
  };

  constructor(content: unknown, options: AnalyzeOptions = {}) {
    this.content = content;
    this.baseUrl = options.baseUrl ?? '';
    this.redirectUrl = options.redirectUrl ?? '';
    this.book = options.book;
    this.chapter = options.chapter;
    this.source = options.source;
    for (const [key, value] of Object.entries(options.variables ?? {})) {
      this.variables.set(key, value);
    }
  }

  setContent(content: unknown): void {
    this.content = content;
  }

  getString(ruleStr: string, mContent?: unknown, isUrl = false, unescape = true): string {
    if (!ruleStr) return '';
    const rules = this.rules(ruleStr);
    let result: unknown = this.getContent(mContent);

    for (const sourceRule of rules) {
      if (result == null) break;
      this.putRule(sourceRule.putMap);
      const resolved = sourceRule.makeUpRule(result, this.env);
      if (resolved.rule !== '') {
        result = this.applyString(sourceRule.mode, resolved.rule, result, isUrl);
      }
      result = this.applyReplace(result, resolved);
    }

    if (result == null) result = '';
    let text = typeof result === 'string' ? result : stringify(result);
    if (unescape && text.includes('&')) text = unescapeHtml4(text);
    if (isUrl) {
      if (!text.trim()) return this.baseUrl;
      return this.toAbsolute(text);
    }
    return text;
  }

  getStringList(ruleStr: string, mContent?: unknown, isUrl = false): string[] | null {
    if (!ruleStr) return null;
    const rules = this.rules(ruleStr);
    let result: unknown = this.getContent(mContent);

    for (const sourceRule of rules) {
      if (result == null) break;
      this.putRule(sourceRule.putMap);
      const resolved = sourceRule.makeUpRule(result, this.env);
      if (resolved.rule !== '') {
        result = this.applyStringList(sourceRule.mode, resolved.rule, result);
      }
      result = this.applyReplace(result, resolved);
    }

    if (result == null) return null;

    let list: string[];
    if (typeof result === 'string') {
      list = result.split('\n');
    } else if (Array.isArray(result)) {
      list = result.map((value) => stringify(value)).filter((value) => value !== '');
    } else if (result instanceof HtmlNode) {
      list = [result.text];
    } else {
      list = [stringify(result)];
    }

    if (isUrl) {
      const absolute: string[] = [];
      for (const url of list) {
        const resolved = this.toAbsolute(url);
        if (resolved && !absolute.includes(resolved)) absolute.push(resolved);
      }
      return absolute;
    }
    return list;
  }

  getElement(ruleStr: string): unknown {
    return this.getElements(ruleStr)[0] ?? null;
  }

  getElements(ruleStr: string): unknown[] {
    if (!ruleStr) return [];
    const rules = this.rules(ruleStr, true);
    let result: unknown = this.content;

    for (const sourceRule of rules) {
      if (result == null) break;
      this.putRule(sourceRule.putMap);
      const resolved = sourceRule.makeUpRule(result, this.env);
      result = this.applyElements(sourceRule.mode, resolved.rule, result);
      result = this.applyReplace(result, resolved);
    }

    if (result == null) return [];
    if (Array.isArray(result)) return result.filter((value) => value != null);
    if (result instanceof HtmlNode) return [result];
    if (typeof result === 'object' && !(result instanceof String)) {
      return [result];
    }
    return [result];
  }

  // ------------------------------------------------------------------ 内容分派

  private applyString(
    mode: RuleMode,
    rule: string,
    content: unknown,
    isUrl: boolean,
  ): unknown {
    switch (mode) {
      case 'Js':
        return this.evalJs(rule, content);
      case 'WebJs':
        throw new Error('@webjs 在 Web 版不可用');
      case 'Json':
        return new JsonPathAnalyzer(this.jsonContent(content)).getString(rule) ?? '';
      case 'XPath':
        return new XPathAnalyzer(this.toHtmlString(content)).getString(rule) ?? '';
      case 'Regex':
        return rule;
      default:
        if (this.isStructured(this.jsonContent(content))) {
          return new JsonPathAnalyzer(this.jsonContent(content)).getString(rule) ?? '';
        }
        if (isUrl) return new JsoupAnalyzer(this.toHtml(content)).getString0(rule);
        return new JsoupAnalyzer(this.toHtml(content)).getString(rule) ?? '';
    }
  }

  private applyStringList(mode: RuleMode, rule: string, content: unknown): unknown {
    switch (mode) {
      case 'Js':
        return this.evalJs(rule, content);
      case 'WebJs':
        throw new Error('@webjs 在 Web 版不可用');
      case 'Json':
        return new JsonPathAnalyzer(this.jsonContent(content)).getStringList(rule);
      case 'XPath':
        return new XPathAnalyzer(this.toHtmlString(content)).getStringList(rule) ?? [];
      case 'Regex':
        return rule;
      default:
        if (this.isStructured(this.jsonContent(content))) {
          return new JsonPathAnalyzer(this.jsonContent(content)).getStringList(rule);
        }
        return new JsoupAnalyzer(this.toHtml(content)).getStringList(rule);
    }
  }

  private applyElements(mode: RuleMode, rule: string, content: unknown): unknown {
    switch (mode) {
      case 'Js':
        return this.evalJs(rule, content);
      case 'WebJs':
        throw new Error('@webjs 在 Web 版不可用');
      case 'Json':
        return new JsonPathAnalyzer(this.jsonContent(content)).getList(rule);
      case 'XPath':
        return new XPathAnalyzer(this.toHtmlString(content)).getElements(rule);
      case 'Regex':
        return new RegexAnalyzer(stringify(content)).getElements(rule);
      default:
        if (this.isStructured(this.jsonContent(content))) {
          return new JsonPathAnalyzer(this.jsonContent(content)).getList(rule);
        }
        return new JsoupAnalyzer(this.toHtml(content)).getElements(rule);
    }
  }

  // ------------------------------------------------------------------ JS / 变量

  private evalJs(script: string, result: unknown): unknown {
    if (!script) return result;
    return evalJs(script, {
      result,
      baseUrl: this.baseUrl,
      book: this.book,
      chapter: this.chapter,
      source: this.source,
      variables: Object.fromEntries(this.variables),
      getStringByRule: (rule) => this.getString(rule),
      getStringListByRule: (rule) => this.getStringList(rule) ?? [],
      getElementByRule: (rule) => this.getElement(rule),
      getElementsByRule: (rule) => this.getElements(rule),
    });
  }

  private getVariable(key: string): string {
    const local = this.variables.get(key);
    if (local != null) return local;
    for (const object of [this.book, this.chapter, this.source]) {
      const variables = (object as { variable?: Record<string, unknown> } | undefined)?.variable;
      if (variables && key in variables) {
        const value = variables[key];
        if (value != null) return String(value);
      }
    }
    return '';
  }

  private putRule(putMap: Record<string, string>): void {
    for (const [key, value] of Object.entries(putMap)) {
      this.variables.set(key, value);
    }
  }

  // ------------------------------------------------------------------ 工具

  private rules(ruleStr: string, allInOne = false): SourceRule[] {
    return splitSourceRule(ruleStr, allInOne).map(
      (segment) => new SourceRule(segment.rule, segment.mode),
    );
  }

  private getContent(mContent?: unknown): unknown {
    return mContent == null ? this.content : mContent;
  }

  /** 响应是 JSON 文本时（书源内容接口常见），按结构化内容处理。 */
  private jsonContent(content: unknown): unknown {
    if (typeof content !== 'string') return content;
    const text = content.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) return content;
    try {
      return JSON.parse(text);
    } catch {
      return content;
    }
  }

  private isStructured(content: unknown): boolean {
    return (
      content != null &&
      typeof content === 'object' &&
      !(content instanceof HtmlNode) &&
      !(content instanceof String)
    );
  }

  private toHtml(content: unknown): string | HtmlNode {
    if (content instanceof HtmlNode) return content;
    if (typeof content === 'string') return content;
    return stringify(content);
  }

  private toHtmlString(content: unknown): string {
    const html = this.toHtml(content);
    return typeof html === 'string' ? html : html.outerHtml;
  }

  private applyReplace(result: unknown, resolved: ResolvedRule): unknown {
    if (!resolved.replaceRegex) return result;
    if (Array.isArray(result)) {
      return result.map((value) => this.replaceRegex(stringify(value), resolved));
    }
    if (typeof result === 'string') return this.replaceRegex(result, resolved);
    return result;
  }

  private replaceRegex(text: string, resolved: ResolvedRule): string {
    if (!resolved.replaceRegex) return text;
    let regex: RegExp;
    try {
      regex = new RegExp(resolved.replaceRegex, resolved.replaceFirst ? '' : 'g');
    } catch {
      return resolved.replaceFirst ? resolved.replacement : text.split(resolved.replaceRegex).join(resolved.replacement);
    }
    if (resolved.replaceFirst) {
      const match = regex.exec(text);
      if (!match) return '';
      try {
        return match[0].replace(new RegExp(resolved.replaceRegex), resolved.replacement);
      } catch {
        return resolved.replacement;
      }
    }
    return text.replace(regex, resolved.replacement);
  }

  private toAbsolute(url: string): string {
    const base = this.redirectUrl || this.baseUrl;
    const trimmed = url.trim();
    if (!trimmed) return '';
    try {
      return new URL(trimmed, base || undefined).toString();
    } catch {
      return trimmed;
    }
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
};

export function unescapeHtml4(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code)) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const value = HTML_ENTITIES[body.toLowerCase()];
    return value ?? match;
  });
}

// 避免 tree-shake 误删：规则串识别在 source-engine 里也会用到。
export { isRuleString };
