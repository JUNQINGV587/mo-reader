/**
 * 阅读（Legado）AnalyzeByJSoup 的移植：
 * - 链式规则 `.book-list@tag.li@a@text`（按顶层 @ 拆段）
 * - 索引语法 `tag.div.0` / `tag.div.-1` / `tag.div[0,2]` / `tag.div[!0]`
 * - 末段取值 text/html/ownText/textNodes/@attr
 * - `&&`、`||`、`%%` 组合
 * - 显式 `@CSS:` 走纯 CSS 选择器
 */
import { load } from 'cheerio';
import { splitTopLevel } from './split.js';

type CheerioLike = any;

/** 一段已解析的 HTML 内容；元素规则在它上面继续跑。 */
export class HtmlNode {
  constructor(
    public readonly $: CheerioLike,
    public readonly node: CheerioLike,
  ) {}

  get outerHtml(): string {
    return this.node.toArray().map((el: any) => this.$.html(el)).join('');
  }

  get text(): string {
    return this.node.text();
  }
}

export class JsoupAnalyzer {
  private readonly $: CheerioLike;
  private readonly root: CheerioLike;

  constructor(content: string | HtmlNode) {
    if (content instanceof HtmlNode) {
      this.$ = content.$;
      this.root = content.node;
      return;
    }
    this.$ = load(content);
    const body = this.$('body');
    this.root = body.length > 0 ? body.first() : this.$.root();
  }

  getString(ruleStr: string): string | null {
    const list = this.getStringList(ruleStr);
    if (list.length === 0) return null;
    if (list.length === 1) return list[0] ?? '';
    return list.join('\n');
  }

  getString0(ruleStr: string): string {
    const list = this.getStringList(ruleStr);
    return list[0] ?? '';
  }

  getStringList(ruleStr: string): string[] {
    if (!ruleStr) return [];
    const sourceRule = new JsoupSourceRule(ruleStr);
    const textList: string[] = [];

    if (!sourceRule.elementsRule) {
      return [this.root.text()];
    }

    const { parts, type } = splitTopLevel(sourceRule.elementsRule);
    const results: string[][] = [];
    for (const part of parts) {
      let temp: string[] | null;
      if (sourceRule.isCss) {
        const at = part.lastIndexOf('@');
        const selector = at >= 0 ? part.slice(0, at) : part;
        const lastRule = at >= 0 ? part.slice(at + 1) : 'text';
        temp = this.getResultLast(this.select(selector), lastRule);
      } else {
        temp = this.getResultList(part);
      }
      if (temp && temp.length > 0) {
        results.push(temp);
        if (type === '||') break;
      }
    }

    if (results.length > 0) {
      if (type === '%%') {
        const first = results[0] ?? [];
        for (let i = 0; i < first.length; i++) {
          for (const temp of results) {
            if (i < temp.length) textList.push(temp[i] as string);
          }
        }
      } else {
        for (const temp of results) textList.push(...temp);
      }
    }
    return textList;
  }

  /** 抽取元素（用于列表规则，随后对每个元素再跑字段规则）。 */
  getElements(ruleStr: string): HtmlNode[] {
    if (!ruleStr) return [];
    const sourceRule = new JsoupSourceRule(ruleStr);
    const { parts, type } = splitTopLevel(sourceRule.elementsRule);
    const results: HtmlNode[][] = [];

    for (const part of parts) {
      let temp: HtmlNode[];
      if (sourceRule.isCss) {
        temp = this.select(part)
          .toArray()
          .map((el: any) => new HtmlNode(this.$, this.$(el)));
      } else {
        temp = this.getElementsByChain(part);
      }
      if (temp.length > 0) {
        results.push(temp);
        if (type === '||') break;
      }
    }

    const out: HtmlNode[] = [];
    if (type === '%%') {
      const first = results[0] ?? [];
      for (let i = 0; i < first.length; i++) {
        for (const temp of results) {
          if (i < temp.length) out.push(temp[i] as HtmlNode);
        }
      }
    } else {
      for (const temp of results) out.push(...temp);
    }
    return out;
  }

  private getResultList(ruleStr: string): string[] | null {
    const chain = splitTopLevel(ruleStr, ['@']).parts;
    if (chain.length === 0) return null;

    let elements: CheerioLike = this.root;
    for (let i = 0; i < chain.length - 1; i++) {
      let next = this.$();
      elements.each((_: number, el: any) => {
        next = next.add(this.getElementSingle(this.$(el), chain[i] as string));
      });
      elements = next;
    }
    if (elements.length === 0) return null;
    return this.getResultLast(elements, chain[chain.length - 1] as string);
  }

  private getElementsByChain(ruleStr: string): HtmlNode[] {
    const chain = splitTopLevel(ruleStr, ['@']).parts;
    if (chain.length === 0) return [];

    let elements: CheerioLike = this.root;
    for (const part of chain) {
      let next = this.$();
      elements.each((_: number, el: any) => {
        next = next.add(this.getElementSingle(this.$(el), part));
      });
      elements = next;
    }
    return elements.toArray().map((el: any) => new HtmlNode(this.$, this.$(el)));
  }

  private select(selector: string): CheerioLike {
    const sel = selector.trim();
    if (!sel) return this.root;
    // 与 Jsoup select 一致：先看自身是否命中，再找后代。
    const self = this.root.filter(sel);
    const found = this.root.find(sel);
    return self.length > 0 ? self.add(found) : found;
  }

  private selfAndFind(temp: CheerioLike, selector: string): CheerioLike {
    const self = temp.filter(selector);
    const found = temp.find(selector);
    return self.length > 0 ? self.add(found) : found;
  }

  private getElementSingle(temp: CheerioLike, rule: string): CheerioLike {
    const spec = findIndexSet(rule);
    let elements: CheerioLike;

    if (!spec.beforeRule) {
      elements = temp.children();
    } else {
      const rules = spec.beforeRule.split('.');
      switch (rules[0]) {
        case 'children':
          elements = temp.children();
          break;
        case 'class':
          elements = this.selfAndFind(temp, `.${rules[1] ?? ''}`);
          break;
        case 'tag':
          elements = this.selfAndFind(temp, rules[1] ?? '*');
          break;
        case 'id':
          elements = this.selfAndFind(temp, `#${rules[1] ?? ''}`);
          break;
        case 'text': {
          const needle = rules.slice(1).join('.');
          elements = temp
            .find('*')
            .filter((_: number, el: any) => ownText(this.$(el)).includes(needle));
          break;
        }
        default:
          elements = this.selfAndFind(temp, spec.beforeRule);
      }
    }

    const len = elements.length;
    const selected: number[] = [];
    const isExclude = spec.mode === '!';

    if (spec.ranges.length > 0) {
      for (const range of spec.ranges) {
        let start = range.start ?? 0;
        let end = range.end ?? len - 1;
        if (start < 0) start += len;
        if (end < 0) end += len;
        start = Math.max(0, Math.min(len - 1, start));
        end = Math.max(0, Math.min(len - 1, end));
        if (range.step > 0) {
          if (end >= start) {
            for (let i = start; i <= end; i += range.step) selected.push(i);
          } else {
            for (let i = start; i >= end; i -= range.step) selected.push(i);
          }
        }
      }
    }
    for (const index of spec.indexes) {
      const idx = index < 0 ? len + index : index;
      if (idx >= 0 && idx < len) selected.push(idx);
    }

    if (selected.length === 0) return elements;

    const unique = [...new Set(selected)];
    if (isExclude) {
      const keep = elements
        .toArray()
        .filter((_: unknown, i: number) => !unique.includes(i));
      return this.$(keep);
    }
    let picked = this.$();
    for (const idx of unique) picked = picked.add(elements.eq(idx));
    return picked;
  }

  private getResultLast(elements: CheerioLike, lastRule: string): string[] {
    const textS: string[] = [];
    const add = (text: string) => {
      if (text) textS.push(text);
    };

    switch (lastRule) {
      case 'text':
        elements.each((_: number, el: any) => add(normalizeText(this.$(el).text())));
        break;
      case 'textNodes':
        elements.each((_: number, el: any) => {
          const tn = this.$(el)
            .contents()
            .toArray()
            .filter((node: any) => node.type === 'text')
            .map((node: any) => String(node.data ?? '').trim())
            .filter(Boolean);
          if (tn.length > 0) textS.push(tn.join('\n'));
        });
        break;
      case 'ownText':
        elements.each((_: number, el: any) => add(ownText(this.$(el))));
        break;
      case 'html': {
        const clone = elements.clone();
        clone.find('script, style').remove();
        add(
          clone
            .toArray()
            .map((el: any) => this.$.html(el))
            .join(''),
        );
        break;
      }
      case 'all':
        add(
          elements
            .toArray()
            .map((el: any) => this.$.html(el))
            .join(''),
        );
        break;
      default:
        elements.each((_: number, el: any) => {
          const value = this.$(el).attr(lastRule) ?? '';
          if (value && !textS.includes(value)) textS.push(value);
        });
    }
    return textS;
  }
}

class JsoupSourceRule {
  readonly isCss: boolean;
  readonly elementsRule: string;

  constructor(ruleStr: string) {
    if (/^@CSS:/i.test(ruleStr)) {
      this.isCss = true;
      this.elementsRule = ruleStr.slice(5).trim();
    } else {
      this.isCss = false;
      this.elementsRule = ruleStr;
    }
  }
}

interface IndexRule {
  beforeRule: string;
  mode: '.' | '!' | ' ';
  indexes: number[];
  ranges: Array<{ start?: number; end?: number; step: number }>;
}

function findIndexSet(rule: string): IndexRule {
  const text = rule.trim();
  const empty: IndexRule = {
    beforeRule: text,
    mode: ' ',
    indexes: [],
    ranges: [],
  };
  if (!text) return empty;

  // 1) [..] 索引：内容必须只由数字、逗号、冒号、负号、感叹号、空格组成，
  //    否则是 CSS 属性选择器（如 a[href]）。
  if (text.endsWith(']')) {
    const open = text.lastIndexOf('[');
    if (open > 0) {
      const content = text.slice(open + 1, -1).trim();
      if (/^[!0-9,: -]+$/.test(content)) {
        const parsed = parseIndexList(content);
        if (parsed) {
          return {
            beforeRule: text.slice(0, open),
            mode: parsed.exclude ? '!' : '.',
            indexes: parsed.indexes,
            ranges: parsed.ranges,
          };
        }
      }
    }
  }

  // 2) 阅读原写法：prefix.0 / prefix.-1 / prefix!0 / prefix.0:3
  let i = text.length - 1;
  while (i >= 0 && /[0-9:\- ]/.test(text[i] as string)) i--;
  if (i >= 0 && (text[i] === '.' || text[i] === '!')) {
    const nums = text
      .slice(i + 1)
      .split(':')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n));
    if (nums.length > 0) {
      return {
        beforeRule: text.slice(0, i),
        mode: text[i] as '.' | '!',
        indexes: nums,
        ranges: [],
      };
    }
  }

  return empty;
}

function parseIndexList(content: string): {
  exclude: boolean;
  indexes: number[];
  ranges: Array<{ start?: number; end?: number; step: number }>;
} | null {
  let text = content.trim();
  if (!text) return null;
  const exclude = text.startsWith('!');
  if (exclude) text = text.slice(1).trim();

  const indexes: number[] = [];
  const ranges: Array<{ start?: number; end?: number; step: number }> = [];

  for (const raw of text.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    if (!/^-?\d*(?::-?\d*){0,2}$/.test(item)) return null;
    const pieces = item.split(':');
    if (pieces.length === 1) {
      const value = Number(pieces[0]);
      if (!Number.isFinite(value)) return null;
      indexes.push(value);
    } else {
      const start = pieces[0] === '' ? undefined : Number(pieces[0]);
      const end = pieces[1] === '' ? undefined : Number(pieces[1]);
      const step = pieces[2] === undefined || pieces[2] === '' ? 1 : Math.abs(Number(pieces[2]));
      if (!Number.isFinite(step) || step <= 0) return null;
      ranges.push({ start, end, step });
    }
  }
  return { exclude, indexes, ranges };
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function ownText(temp: CheerioLike): string {
  return normalizeText(
    temp
      .contents()
      .toArray()
      .filter((node: any) => node.type === 'text')
      .map((node: any) => String(node.data ?? ''))
      .join(''),
  );
}
