/**
 * 阅读 AnalyzeByJSonPath 的移植。
 * - `&&` / `||` / `%%` 组合
 * - `{$...}` 内嵌规则先替换再查询
 * - 列表结果按换行拼接（与阅读一致）
 */
import { JSONPath } from 'jsonpath-plus';
import { replaceInnerJsonRules, splitTopLevel } from './split.js';

export class JsonPathAnalyzer {
  private readonly value: unknown;

  constructor(content: string | unknown) {
    if (typeof content === 'string') {
      this.value = parseJson(content);
    } else {
      this.value = content;
    }
  }

  getString(ruleStr: string): string | null {
    const list = this.getStringList(ruleStr);
    if (list.length === 0) return null;
    return list.join('\n');
  }

  getString0(ruleStr: string): string {
    return this.getStringList(ruleStr)[0] ?? '';
  }

  getStringList(ruleStr: string): string[] {
    const list = this.getList(ruleStr);
    return list.map((value) => stringify(value)).filter((value) => value !== '');
  }

  /** 规则命中的原始值（数组展开后）。 */
  getList(ruleStr: string): unknown[] {
    if (!ruleStr) return [this.value];
    const { parts, type } = splitTopLevel(ruleStr);
    const results: unknown[][] = [];

    for (const part of parts) {
      const resolved = replaceInnerJsonRules(part, (inner) => this.getString(inner));
      const list = this.query(resolved);
      if (list.length > 0) {
        results.push(list);
        if (type === '||') break;
      }
    }

    if (results.length === 0) return [];
    if (type === '%%') {
      const out: unknown[] = [];
      const first = results[0] as unknown[];
      for (let i = 0; i < first.length; i++) {
        for (const list of results) {
          if (i < list.length) out.push(list[i]);
        }
      }
      return out;
    }
    return results.flat();
  }

  private query(ruleStr: string): unknown[] {
    let path = ruleStr.trim();
    if (!path) return [this.value];
    if (!path.startsWith('$')) path = `$.${path}`;
    try {
      const result = JSONPath({ path, json: this.value as never, wrap: true }) as unknown;
      if (Array.isArray(result)) return result;
      return result === undefined ? [] : [result];
    } catch {
      return [];
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
