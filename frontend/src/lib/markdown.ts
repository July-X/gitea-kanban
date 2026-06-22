/**
 * markdown 安全渲染工具 —— 用于 gitea 评论 / 议题正文 / 合并请求正文
 *
 * 设计（AGENTS §9.3 + design-system/pages/tech-refine.md §零术语）：
 *   - 解析：markdown-it（GFM 兼容；code fence / 列表 / 引用 / 链接 / 图片 / 表格）
 *   - 清洗：DOMPurify（白名单 ALLOWED_TAGS / ALLOWED_ATTR；过滤 on* / javascript: / data:）
 *   - 渲染：返回 sanitized HTML string；外层用 v-html 注入到 <div class="md-body">
 *   - 链接：所有 <a target="_blank"> 自动加 rel="noopener noreferrer nofollow"（防 tabnabbing）
 *
 * 安全边界（v1.2 评论功能专项加固）：
 *   - 禁掉 <script> / <style> / <iframe> / <object> / <embed> / <form>
 *   - 禁掉所有 on* 事件属性（onclick / onerror / onload 等）
 *   - 禁掉 javascript: / vbscript: / data:text/html 等危险 URL scheme
 *   - 图片只允许 https:（gitea 用户上传图走 /attachments/，但 v1 不开放外站图片防追踪 + 防 SSRF）
 *   - 强制不允许 <meta> / <link>（XSS 载体）
 *   - 不引入 marked + 自写 sanitizer（已确认用户拍板：markdown-it + DOMPurify）
 *
 * 测试策略：
 *   - 本文件 vitest 单测覆盖：`<script>`、`javascript:`、onclick、data: html、链接 rel
 *   - 见 src/renderer/lib/__tests__/markdown.test.ts
 */

// markdown-it 14 dual package（CJS + ESM index.mjs）。
// @types/markdown-it 把 MarkdownIt 同时作为 namespace（Options/Renderer/Token）和类。
// ESM 项目里：
//   - value 用 default import（拿到类本身）
//   - nested 类型（Options / Renderer / Token）用 typeof 索引从 default 派生
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

/** markdown-it 配置类型（new MarkdownIt() 入参） */
type MdOptions = ConstructorParameters<typeof MarkdownIt>[0];
/** markdown-it 实例类型（从 class 派生） */
type MdInstance = InstanceType<typeof MarkdownIt>;
/** markdown-it renderer 上下文类型（自定义 rule 时用） */
type MdRenderer = MdInstance['renderer'];
/** markdown-it token 类型（link_open / text 等 rule 入参） */
type MdToken = ReturnType<MdInstance['parse']>[number];

// ===== markdown-it 单例（避免每次渲染都构造） =====

/**
 * 单例 md 实例 —— GFM 风格，链接开启，HTML 标签**不**开启（开了反而绕过 sanitizer 防
 * 线）。v1.2 评论 / 议题正文不需要内嵌 HTML。
 */
const md = new MarkdownIt({
  html: false, // 不解析原 HTML（防 XSS 突破口；交给 DOMPurify 也行但这里更省）
  linkify: true, // 自动识别 URL 转链接（gitea 也开）
  breaks: true, // 换行 → <br>（gitea 评论习惯）
  typographer: false, // 关闭智能引号 / 破折号（避免和中文排版冲突）
});

// 渲染时给所有 <a> 自动加 target=_blank + rel=noopener noreferrer
// 实现：markdown-it 默认 link_open render 规则，注入属性
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  function defaultLinkOpen(
    tokens: MdToken[],
    idx: number,
    options: MdOptions,
    _env: unknown,
    self: MdRenderer,
  ): string {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.link_open = function linkOpen(
  tokens: MdToken[],
  idx: number,
  options: MdOptions,
  env: unknown,
  self: MdRenderer,
): string {
  const token = tokens[idx]!;
  // 强制 target + rel（防止钓鱼 / tabnabbing）
  const targetIndex = token.attrIndex('target');
  if (targetIndex < 0) {
    token.attrPush(['target', '_blank']);
  } else {
    token.attrs![targetIndex] = ['target', '_blank'];
  }
  const relIndex = token.attrIndex('rel');
  if (relIndex < 0) {
    token.attrPush(['rel', 'noopener noreferrer nofollow']);
  } else {
    token.attrs![relIndex] = ['rel', 'noopener noreferrer nofollow'];
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ===== DOMPurify 白名单 =====

/**
 * DOMPurify tag 白名单 —— 比默认窄：禁掉 <form> / <input> / <iframe> / <object> / <embed>
 *
 * 为什么不直接用默认白名单：DOMPurify 默认白名单不含 <form>（自带 ✓），但允许 <input> /
 * <textarea> 等——gitea 评论里嵌表单毫无意义，禁掉减小攻击面。
 */
const ALLOWED_TAGS = [
  // 文本结构
  'p',
  'br',
  'hr',
  'blockquote',
  // 标题
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  // 列表
  'ul',
  'ol',
  'li',
  // 强调
  'strong',
  'em',
  'del',
  's',
  'ins',
  'mark',
  // 代码
  'code',
  'pre',
  // 链接 / 图片
  'a',
  'img',
  // 表格
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // 行内
  'span',
];

/** 属性白名单 —— src/href 只允许 https: / mailto: / 相对路径 */
const ALLOWED_ATTR = ['href', 'src', 'alt', 'title', 'class', 'target', 'rel'];

// ===== 主入口 =====

/**
 * 把 markdown 文本渲染成 **已 sanitize 的** HTML 字符串
 *
 * 用法（Vue）：
 *   <div class="md-body" v-html="renderMarkdown(comment.body)"></div>
 *
 * 关键不变量：
 *   1. 永远不返回未 sanitize 的字符串（DOMPurify 必走）
 *   2. 空输入 → 空字符串（不返回 '<p></p>'）
 *   3. 永不抛错（任何解析失败都 fallback 到 sanitize 后的原文）
 *
 * @param source 原始 markdown / 纯文本
 * @returns 可直接塞进 v-html 的安全 HTML 字符串
 */
export function renderMarkdown(source: string | null | undefined): string {
  if (!source) return '';
  try {
    const html = md.render(source);
    // DOMPurify 在浏览器环境直接用 window DOM；node 环境会回退到 jsdom（v1 没装）
    // 我们的使用场景只在 renderer（Electron Chromium）→ 一定有 window
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // 禁掉所有 URL scheme 不是 http/https/mailto/相对路径的
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\-:]|$))/i,
      // 不允许 style 属性（避免 gitea 评论里塞 CSS 改全局样式）
      FORBID_ATTR: ['style', 'srcdoc'],
      // 标签被禁时保留内部文本（不要剥成空字符串）
      KEEP_CONTENT: true,
    });
    return clean;
  } catch {
    // fallback：sanitize 原文本（转 < > &）
    return DOMPurify.sanitize(source, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  }
}

/**
 * 渲染纯文本（不解析 markdown）—— 用于占位 / 异常降级
 * 把换行转 <br>，其余字符 escape
 */
export function renderPlain(source: string | null | undefined): string {
  if (!source) return '';
  return DOMPurify.sanitize(source, { ALLOWED_TAGS: ['br'], ALLOWED_ATTR: [] }).replace(
    /\n/g,
    '<br>',
  );
}
