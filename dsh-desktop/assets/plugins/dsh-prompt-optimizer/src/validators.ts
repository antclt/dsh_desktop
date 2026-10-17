/** 校验内核：从原文提取「必须逐字保留」的实体（围栏代码块正文 / {{变量}} / URL / 文件路径），
 *  与优化结果比对，产出缺失（missing）与新增（added）清单 —— 纯函数，零依赖。
 *
 *  口径（保守优先——误报会白烧一次修复调用，宁可漏检不可误检）：
 *  · 路径只认「末段带字母开头扩展名」的形态——「和/或」「3/4」、日期、MIME 类型一律不算；
 *  · URL 先扫描并遮蔽其跨度，URL 内部片段不会被重复认作路径；
 *  · 配对成功的代码块整段遮蔽，块内内容不再单独成实体——块丢只报一条；
 *  · 被更长实体完整包含的条目（如同一路径的二次匹配尾段）经 pruneNested 去重；
 *  · 未配平的围栏之后的整段忽略（原文残缺时只信能配对的部分）。 */

export type EntityKind = 'code' | 'variable' | 'url' | 'path';

export interface Entity {
  kind: EntityKind;
  /** 应逐字保留的文本（code = 围栏内正文；variable = 原始匹配；url/path = 尾缀清理后的 token） */
  text: string;
}

export interface PreservationReport {
  /** 原文有而结果没有（逐字比对）的实体 —— 修复重试的触发条件 */
  missing: Entity[];
  /** 结果有而原文没有的实体 —— 仅诊断，不触发修复 */
  added: Entity[];
  /** 实际参与比对的原文实体数（去重嵌套后）；0 = 无可校验实体 */
  checked: number;
}

interface Span {
  start: number;
  end: number;
}

interface LocatedEntity extends Entity {
  at: number;
}

/** 围栏行：可带块引用前缀 + 3 个以上反引号/波浪线 + 可选语言标记（配对键是字符族与长度，对齐 CommonMark） */
const FENCE_LINE = /^\s*(?:>\s*)?(`{3,}|~{3,})\s*[A-Za-z0-9_+.-]*\s*$/;

/** URL：到空白/引号/中英标点/CJK 文字/表情为止；尾缀句读与多余的右括号由 trimUrlTail 裁掉 */
const URL_RE = /https?:\/\/[^\s"'<>\u201c\u201d\u2018\u2019\uff02`|*，。；：！？、（）【】《》\u3000-\u303f\uff00-\uffef\u4e00-\u9fff\ud800-\udfff]+/g;

/** 路径：优先「有根前缀」（盘符/相对/家目录/反斜杠根），否则「裸多段」（末段过滤见 cleanPathToken） */
const PATH_RE =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|\/)[^\s"'<>\u201c\u201d\u2018\u2019\uff02`|*?()\[\]{}，。；：、（）【】《》,;:!！?？]+|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+/g;

const VARIABLE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** 扩展名形态：字母开头、总长 ≤ 10（.ts/.tsx/.mjs/.json/.env 过，纯数字段不过） */
const EXT_TAIL = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

/** 按跨度把字符换成空格（换行保留）：后续扫描看不到已识别的区域，但不破坏行结构 */
function maskSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) return text;
  const chars = text.split('');
  for (const span of spans) {
    for (let i = span.start; i < span.end; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function plain(entities: LocatedEntity[]): Entity[] {
  return entities.map((e) => ({ kind: e.kind, text: e.text }));
}

function byPosition(entities: LocatedEntity[]): LocatedEntity[] {
  return entities.sort((a, b) => a.at - b.at);
}

/** 围栏代码块：toggle 配对（同字符且闭合不短于开启；未配平的尾段忽略）。返回实体与遮蔽跨度。 */
function scanCode(text: string): { entities: LocatedEntity[]; spans: Span[] } {
  const entities: LocatedEntity[] = [];
  const spans: Span[] = [];
  let open: { char: string; len: number; bodyStart: number; lineStart: number } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const m = FENCE_LINE.exec(line);
    if (m) {
      if (open === null) {
        open = { char: m[1][0], len: m[1].length, bodyStart: lineEnd + 1, lineStart };
      } else if (m[1][0] === open.char && m[1].length >= open.len) {
        const body = text.slice(open.bodyStart, lineStart).trim();
        if (body) {
          entities.push({ kind: 'code', text: body, at: open.lineStart });
          spans.push({ start: open.lineStart, end: lineEnd });
        }
        open = null;
      }
    }
    offset = lineEnd + 1;
  }
  return { entities, spans };
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

/** 裁掉 URL 尾缀：句读标点无条件；右括号/右方括号按平衡（对应左括号不在跨度内的才裁） */
function trimUrlTail(raw: string): string {
  let u = raw.replace(/[.,;:!?]+$/, '');
  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['[', ']'],
  ];
  for (const [open, close] of pairs) {
    while (u.endsWith(close) && countChar(u, close) > countChar(u, open)) {
      u = u.slice(0, -1);
    }
  }
  return u.replace(/[.,;:!?]+$/, '');
}

function scanUrls(text: string): LocatedEntity[] {
  const out: LocatedEntity[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const cleaned = trimUrlTail(m[0]);
    if (cleaned) out.push({ kind: 'url', text: cleaned, at: m.index ?? 0 });
  }
  return out;
}

/** 清洗路径 token：去尾缀标点与尾分隔符，末段须是「字母开头扩展名」，否则整条丢弃（保守口径） */
function cleanPathToken(raw: string): string | null {
  const token = raw.replace(/[.,;:!?、。，；：！？]+$/, '').replace(/[\\/]+$/, '');
  if (!token) return null;
  const last = token.split(/[\\/]/).pop() ?? '';
  if (!EXT_TAIL.test(last)) return null;
  return token;
}

function scanPaths(text: string): LocatedEntity[] {
  const out: LocatedEntity[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const cleaned = cleanPathToken(m[0]);
    if (cleaned) out.push({ kind: 'path', text: cleaned, at: m.index ?? 0 });
  }
  return out;
}

function scanVariables(text: string): LocatedEntity[] {
  const out: LocatedEntity[] = [];
  for (const m of text.matchAll(VARIABLE_RE)) {
    out.push({ kind: 'variable', text: m[0], at: m.index ?? 0 });
  }
  return out;
}

/** 提取围栏代码块正文（配对失败忽略尾段） */
export function extractCodeBlocks(text: string): Entity[] {
  return plain(scanCode(text).entities);
}

/** 提取 {{变量}}（JSON 的双花括号因内层含花括号不会被误报） */
export function extractVariables(text: string): Entity[] {
  return plain(scanVariables(text));
}

/** 提取 URL（尾缀标点清理、括号按平衡） */
export function extractUrls(text: string): Entity[] {
  return plain(scanUrls(text));
}

/** 提取文件路径（保守口径；先遮蔽 URL 跨度，URL 内部不会产出路径实体） */
export function extractPaths(text: string): Entity[] {
  const urls = scanUrls(text);
  const masked = maskSpans(
    text,
    urls.map((u) => ({ start: u.at, end: u.at + u.text.length })),
  );
  return plain(scanPaths(masked));
}

/** 全部实体（按原文出现顺序）。流水线内逐层遮蔽：代码块 → URL → 路径/变量，
 *  块内与 URL 内的内容不再单独成实体（一次丢失只报最外层一条）。 */
export function extractEntities(text: string): Entity[] {
  const code = scanCode(text);
  const maskedCode = maskSpans(text, code.spans);
  const urls = scanUrls(maskedCode);
  const maskedUrls = maskSpans(
    maskedCode,
    urls.map((u) => ({ start: u.at, end: u.at + u.text.length })),
  );
  const paths = scanPaths(maskedUrls);
  const variables = scanVariables(maskedCode);
  return plain(byPosition([...code.entities, ...urls, ...paths, ...variables]));
}

/** 去掉被更长实体完整包含的条目（同文本重复保留首个）：同一处丢失不重复报数 */
export function pruneNested(entities: Entity[]): Entity[] {
  return entities.filter((e, i) =>
    !entities.some((f, j) => {
      if (i === j) return false;
      if (f.text.length !== e.text.length) return f.text.length > e.text.length && f.text.includes(e.text);
      return j < i && f.text === e.text;
    }),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 单实体的「逐字保留」判定：variable 容忍花括号内空白，url 容忍末尾斜杠，code/path 严格包含 */
function preserved(entity: Entity, result: string): boolean {
  if (entity.kind === 'variable') {
    const inner = entity.text.slice(2, -2).trim();
    return new RegExp(`\\{\\{\\s*${escapeRegExp(inner)}\\s*\\}\\}`).test(result);
  }
  if (entity.kind === 'url') {
    return result.includes(entity.text.replace(/\/$/, ''));
  }
  return result.includes(entity.text);
}

/** 诊断用的实体等价（added 判定沿用 preserved 的宽容口径：variable 忽略花括号内空白、url 忽略末斜杠） */
function sameEntity(a: Entity, b: Entity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'variable') return a.text.slice(2, -2).trim() === b.text.slice(2, -2).trim();
  if (a.kind === 'url') return a.text.replace(/\/$/, '') === b.text.replace(/\/$/, '');
  return a.text === b.text;
}

/** 逐字保留校验：missing = 原文实体在结果中找不到（修复触发条件）；added = 结果新引入的实体（仅诊断） */
export function validatePreservation(source: string, result: string): PreservationReport {
  const src = pruneNested(extractEntities(source));
  const res = pruneNested(extractEntities(result));
  const missing = src.filter((e) => !preserved(e, result));
  const added = res.filter((e) => !src.some((s) => sameEntity(s, e)));
  return { missing, added, checked: src.length };
}
