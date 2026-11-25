/**
 * 字典规则（对齐阅读 Legado 的 DictRule）。
 *
 * 字段名与 Legado 的 Kotlin bean 保持一致，未知字段由 passthrough 原样保留，
 * 方便直接导入/导出 Legado 的字典 JSON。
 */
import { z } from 'zod';

export const DictRuleSchema = z
  .object({
    name: z.string().default(''),
    url: z
      .string('缺少字典地址')
      .trim()
      .min(1, '缺少字典地址')
      .refine((value) => value.includes('{{key}}'), '字典地址必须包含 {{key}}'),
    rule: z
      .string('字典规则不能为空')
      .trim()
      .min(1, '字典规则不能为空'),
    enabled: z.boolean().default(true),
    group: z.string().default(''),
  })
  .passthrough();

export type DictRule = z.infer<typeof DictRuleSchema>;

export function parseDictRule(raw: unknown): DictRule {
  return DictRuleSchema.parse(raw);
}

/**
 * 稳定 id：只由名称与地址决定，重复导入同一条字典不会产生新条目；
 * 改名或改地址会被视为另一本字典。
 */
export function dictRuleKey(name: string, url: string): string {
  return `dict-${stableHash(`${name.trim()}\n${url.trim()}`)}`;
}

/** 不依赖 node:crypto 的 64 位 FNV 变体，浏览器端也能用。 */
function stableHash(value: string): string {
  let high = 0x9e3779b9;
  let low = 0x85ebca6b;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high + code, 0xc2b2ae35) >>> 0;
    high = (high ^ (high >>> 13)) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
