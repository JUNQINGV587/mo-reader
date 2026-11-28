/**
 * 书源校验错误的中文化。
 *
 * 服务端保存/导入书源时只把这里产出的中文消息交给界面，避免把 zod 的英文
 * 原始 issue 直接透给读者。字段名按书源模型映射；遇到未知字段/规则时保留
 * 一个可读的兜底，而不是抛出 issue 对象。
 */
import { ZodError } from 'zod';

const FIELD_LABELS: Record<string, string> = {
  bookSourceUrl: '地址',
  bookSourceName: '名称',
  bookSourceGroup: '分组',
  bookSourceType: '类型',
  bookSourceComment: '备注',
  enabled: '启用',
  enabledExplore: '发现',
  enabledCookieJar: 'Cookie',
  customOrder: '排序',
  lastUpdateTime: '更新时间',
  respondTime: '响应时间',
  weight: '权重',
  exploreUrl: '发现地址',
  searchUrl: '搜索地址',
  header: '请求头',
  loginUrl: '登录地址',
  loginUi: '登录界面',
  loginCheckJs: '登录检查脚本',
  jsLib: '公共脚本',
  mainJs: '主脚本',
  concurrentRate: '并发设置',
  variableComment: '变量说明',
  bookList: '书单',
  name: '书名',
  author: '作者',
  kind: '分类',
  wordCount: '字数',
  rating: '评分',
  lastChapter: '最新章节',
  intro: '简介',
  coverUrl: '封面',
  bookUrl: '书页',
  tocUrl: '目录',
  checkKeyWord: '校验词',
  init: '初始化脚本',
  canReName: '改名规则',
  chapterList: '章节列表',
  chapterName: '章节名',
  chapterUrl: '章节地址',
  formatJs: '格式化脚本',
  isVolume: '分卷',
  nextTocUrl: '下一页目录',
  content: '正文',
  nextContentUrl: '下一页正文',
  webJs: '网页脚本',
  sourceRegex: '源替换',
  replaceRegex: '替换',
  imageStyle: '图片样式',
  reviewUrl: '段评地址',
  reviewSummaryUrl: '段评概要地址',
  summaryListRule: '概要列表',
  summaryParagraphIndexRule: '概要段落',
  summaryParagraphDataRule: '概要数据',
  summaryCountRule: '概要数量',
  reviewQuoteUrl: '段评引用地址',
  reviewDetailUrl: '段评详情地址',
  detailListRule: '详情列表',
  contentRule: '内容',
  postTimeRule: '发布时间',
  avatarRule: '头像',
};

const RULE_GROUPS: Record<string, string> = {
  ruleSearch: '搜索规则',
  ruleBookInfo: '详情规则',
  ruleToc: '目录规则',
  ruleContent: '正文规则',
  ruleReview: '段评规则',
  ruleExplore: '发现规则',
};

const TYPE_LABELS: Record<string, string> = {
  string: '文本',
  number: '数字',
  int: '整数',
  integer: '整数',
  bigint: '整数',
  boolean: '是/否',
  array: '列表',
  object: '对象',
  date: '日期',
  undefined: '空值',
  null: '空值',
  nan: '数字',
};

function pathLabel(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '书源';
  const head = String(path[0]);
  const rest = path.slice(1).map(String);
  if (RULE_GROUPS[head] && rest.length > 0) {
    const leaf = rest.map((key) => FIELD_LABELS[key] ?? '字段「' + key + '」').join('·');
    return RULE_GROUPS[head] + '·' + leaf;
  }
  if (FIELD_LABELS[head]) return FIELD_LABELS[head];
  return '字段「' + path.map(String).join('.') + '」';
}

function tooSmallMessage(issue: any): string {
  const minimum = Number(issue.minimum);
  if (issue.origin === 'string') {
    return minimum <= 1 ? '不能为空' : '至少 ' + minimum + ' 个字符';
  }
  if (issue.origin === 'array' || issue.origin === 'set') {
    return '至少 ' + minimum + ' 项';
  }
  return '不能小于 ' + minimum;
}

function tooBigMessage(issue: any): string {
  const maximum = Number(issue.maximum);
  if (issue.origin === 'string') return '不能超过 ' + maximum + ' 个字符';
  if (issue.origin === 'array' || issue.origin === 'set') return '最多 ' + maximum + ' 项';
  return '不能大于 ' + maximum;
}

function issueMessage(issue: any): string {
  switch (issue.code) {
    case 'invalid_type': {
      const missing = /received (undefined|null)\b/.test(String(issue.message ?? ''));
      if (issue.received === 'undefined' || issue.received === 'null' || missing) return '不能为空';
      if (issue.expected === 'int' || issue.expected === 'integer') return '应为整数';
      return '应为' + (TYPE_LABELS[String(issue.expected)] ?? '有效值');
    }
    case 'too_small':
      return tooSmallMessage(issue);
    case 'too_big':
      return tooBigMessage(issue);
    case 'invalid_format':
    case 'format':
      return '格式不正确';
    case 'invalid_value':
    case 'invalid_enum_value': {
      const values = Array.isArray(issue.values) ? issue.values : Array.isArray(issue.options) ? issue.options : [];
      return values.length > 0 ? '只能为' + values.map((value: unknown) => '「' + String(value) + '」').join('、') : '取值不在允许范围';
    }
    case 'invalid_union':
      return '不符合允许的格式';
    case 'unrecognized_keys': {
      const keys = Array.isArray(issue.keys) ? issue.keys : [];
      return keys.length > 0 ? '包含不认识的字段：' + keys.join('、') : '包含不认识的字段';
    }
    case 'not_multiple_of':
      return '应为 ' + Number(issue.divisor) + ' 的倍数';
    case 'not_finite':
      return '应为有限数字';
    case 'invalid_key':
    case 'invalid_element':
      return '列表项格式不正确';
    default:
      return '填写内容不合法';
  }
}

/** 单条错误的完整中文文案；多条 issue 用「；」连接。 */
export function formatSourceError(error: unknown): string {
  if (error instanceof ZodError) {
    const messages = error.issues.map((issue) => pathLabel(issue.path) + issueMessage(issue));
    const unique = [...new Set(messages)].filter(Boolean);
    return unique.length > 0 ? unique.join('；') : '书源校验失败';
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return '书源校验失败';
}

/** 批量导入固定带上输入序号，便于逐条对照原始 JSON。 */
export function formatSourceImportError(index: number, error: unknown): string {
  return '第 ' + (Math.max(0, Math.floor(index)) + 1) + ' 条：' + formatSourceError(error);
}
