/**
 * 阅读 AnalyzeByXPath 的常见子集移植（基于 cheerio）：
 * - `/html/body/...`、`//div/...`、`//*[@id="x"]`
 * - 谓词：`[n]`、`[last()]`、`[@attr]`、`[@attr="v"]`、`[contains(@class,"x")]`
 * - 取值：末段 `text()`、`@attr`
 * 复杂 XPath（轴、函数、union）不在 M1 范围内，遇到时返回空。
 */
import { load } from 'cheerio';

interface Step {
  axis: 'child' | 'descendant';
  tag: string;
  predicates: string[];
}

export class XPathAnalyzer {
  private readonly $: any;
  private readonly root: any;

  constructor(html: string) {
    this.$ = load(html);
    this.root = this.$.root();
  }

  getString(ruleStr: string): string | null {
    const list = this.getElements(ruleStr);
    return list.length > 0 ? list.join('\n') : null;
  }

  getString0(ruleStr: string): string {
    return this.getElements(ruleStr)[0] ?? '';
  }

  getStringList(ruleStr: string): string[] {
    return this.getElements(ruleStr);
  }

  getElements(ruleStr: string): string[] {
    const rule = ruleStr.trim();
    if (!rule) return [];

    const steps = parseSteps(rule);
    if (steps.length === 0) return [];

    let current: any = this.root;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as Step;

      if (step.tag === 'text()' || step.tag.startsWith('@')) {
        if (i !== steps.length - 1) return [];
        return this.access(current, step.tag);
      }

      let next: any;
      if (step.axis === 'descendant') {
        next = current.find(step.tag === '*' ? '*' : step.tag);
      } else {
        next = current.children(step.tag === '*' ? '*' : step.tag);
      }

      for (const predicate of step.predicates) {
        next = applyPredicate(next, predicate, this.$);
        if (next.length === 0) return [];
      }
      current = next;
      if (current.length === 0) return [];
    }

    return current.toArray().map((el: any) => this.$.html(el));
  }

  private access(elements: any, accessor: string): string[] {
    if (accessor === 'text()') {
      return elements
        .toArray()
        .map((el: any) => this.$(el).text().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }
    const attr = accessor.slice(1);
    return elements
      .toArray()
      .map((el: any) => this.$(el).attr(attr) ?? '')
      .filter(Boolean);
  }
}

function parseSteps(path: string): Step[] {
  const normalized = path.startsWith('.') ? path.slice(1) : path;
  if (!normalized.startsWith('/')) return parseSteps(`//${normalized}`);

  const raw = splitPath(normalized);
  const steps: Step[] = [];
  let axis: 'child' | 'descendant' = 'child';

  for (let i = 0; i < raw.length; i++) {
    const segment = (raw[i] ?? '').trim();
    if (!segment) {
      axis = 'descendant';
      continue;
    }
    if (/^(\.|\.\.|descendant::|ancestor::|following::|preceding::)/.test(segment)) {
      return [];
    }
    const parsed = parseSegment(segment);
    if (!parsed) return [];
    steps.push({ axis, ...parsed });
    axis = 'child';
  }

  // `/html` 的第一段是 root 的子节点；`//div` 首段用 descendant。
  if (steps.length > 0 && normalized.startsWith('//')) {
    steps[0] = { ...steps[0], axis: 'descendant' } as Step;
  }
  return steps;
}

function parseSegment(segment: string): { tag: string; predicates: string[] } | null {
  if (segment === 'text()') return { tag: 'text()', predicates: [] };
  if (segment.startsWith('@') && !segment.startsWith('@*')) {
    return { tag: segment, predicates: [] };
  }

  const match = /^([^[]*)((?:\[[^\]]*\])*)$/.exec(segment);
  if (!match) return null;
  const tag = (match[1] ?? '').trim();
  if (!tag) return null;
  const predicates = [...(match[2] ?? '').matchAll(/\[([^\]]*)\]/g)].map(
    (item) => (item[1] ?? '').trim(),
  );
  return { tag, predicates };
}

function applyPredicate(elements: any, raw: string, $: any): any {
  const predicate = raw.trim();

  if (/^\d+$/.test(predicate)) {
    const index = Number(predicate) - 1;
    return elements.eq(index);
  }
  if (predicate === 'last()') {
    return elements.length > 0 ? elements.eq(elements.length - 1) : elements;
  }

  const exists = /^@([\w:-]+)$/.exec(predicate);
  if (exists) {
    return elements.filter((_: number, el: any) => $(el).attr(exists[1] as string) != null);
  }

  const eq = /^@([\w:-]+)\s*=\s*(['"])(.*)\2$/.exec(predicate);
  if (eq) {
    return elements.filter(
      (_: number, el: any) => $(el).attr(eq[1] as string) === eq[3],
    );
  }

  const contains = /^contains\(\s*@([\w:-]+)\s*,\s*(['"])(.*)\2\s*\)$/.exec(predicate);
  if (contains) {
    return elements.filter((_: number, el: any) =>
      ($(el).attr(contains[1] as string) ?? '').includes(contains[3] as string),
    );
  }

  return $([]);
}

function splitPath(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '/' && depth === 0) {
      out.push(path.slice(start, i));
      start = i + 1;
    }
  }
  out.push(path.slice(start));
  return out;
}
