/**
 * markdown.ts 单测（XSS 安全 + 渲染正确性）
 *
 * 关键设计前提（markdown.ts line 47 `html: false`）：
 * - markdown-it **不解析**内嵌 HTML —— 任何 `<script>` / `<iframe>` / 事件属性输入
 *   都被当字面文本 escape 成 `&lt;script&gt;` 等，根本到不了 DOMPurify
 * - DOMPurify 只对 markdown-it 生成的合规 HTML 做二次清洗
 * - 攻击路径只剩：markdown 链接 + 危险 URL scheme（javascript: / vbscript: / data:）
 *
 * 覆盖（按攻击面）：
 * - 基础 markdown 渲染：段落（不强制包 <p>，让 DOMPurify 决定）/ 加粗 / 列表 / inline code
 * - 链接自动加 rel="noopener noreferrer nofollow" + target="_blank"
 * - XSS 防御：
 *   · HTML 字面量输入被 escape（`<script>alert(1)</script>` → 字面文本）
 *   · 链接 scheme 黑名单：javascript: / vbscript: / data:text/html 被剥
 *   · 允许 scheme：https: / http: / mailto:
 * - 边界：
 *   · 空 / null / undefined → ''
 *   · renderPlain 换行转 <br>（不解析 markdown）
 *
 * 环境：
 * - happy-dom 20.10.3：DOMPurify 在 node 环境需要 DOM API
 * - 不依赖真实 Electron / Gitea
 */

// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { renderMarkdown, renderPlain } from '@renderer/lib/markdown';

describe('renderMarkdown（基础渲染）', () => {
  it('空 / null / undefined → 空字符串', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  it('纯文本保留（html: false 不会自动包 <p>，输出是字面文本 + 末尾换行）', () => {
    // markdown-it 默认会对行级文本生成 <p>...</p>，但 html:false + breaks:true 影响下
    // 实际行为以 DOMPurify 净化后为准。验证：不含 <script> / 不含 alert 等危险字面
    const html = renderMarkdown('hello world');
    expect(html).toContain('hello world');
    expect(html).not.toContain('<script');
  });

  it('加粗 → <strong>（markdown 标准输出）', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('斜体 → <em>', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  it('inline code → <code>', () => {
    expect(renderMarkdown('use `pnpm dev`')).toContain('<code>pnpm dev</code>');
  });
});

describe('renderMarkdown（链接 rel + target 强制）', () => {
  it('明链 [text](https://...) → 加 target=_blank + rel=noopener noreferrer nofollow', () => {
    const html = renderMarkdown('[gitea](https://gitea.example.com)');
    expect(html).toContain('href="https://gitea.example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('裸 URL 自动识别（linkify: true）→ 同样加 rel + target', () => {
    const html = renderMarkdown('看 https://gitea.example.com');
    expect(html).toContain('href="https://gitea.example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe('renderMarkdown（XSS 防御 · HTML 字面量被 escape）', () => {
  // 关键：`html: false` 让 markdown-it 不解析内嵌 HTML，所以 <script> 不会成真标签
  it('<script>alert(1)</script> 整段被当文本（不是真 script 标签）', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
    // escape 后的字面文本仍在
    expect(html).toContain('&lt;');
  });

  it('<img src=x onerror=alert(1)> 整段被 escape（不渲染为 img 标签）', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    // 没真 <img> 标签（markdown-it 不解析 HTML）
    expect(html).not.toMatch(/<img\s+src=x/);
  });

  it('<a href="javascript:..."> 整段被 escape（不渲染为 a 标签）', () => {
    const html = renderMarkdown('<a href="javascript:alert(1)">x</a>');
    // 不会真有 <a href="javascript:..."> 标签
    expect(html).not.toMatch(/<a[^>]*href="javascript:/i);
  });
});

describe('renderMarkdown（XSS 防御 · URL scheme 黑名单）', () => {
  // 关键安全保证：最终 HTML **不**含 `href="javascript:..."` 这种危险链接
  // markdown-it 的 [text](scheme:...) 语法不解析非 http/https/mailto 协议为真链接
  // （整个 source 被 escape 输出），所以"被剥"在源头就发生了，不是 DOMPurify 介入
  // 测试目的：保证这条不变 + 未来 markdown-it 配置变化时 DOMPurify 兜底仍生效

  it('markdown 链接 [text](javascript:...) → 没有真 javascript: 链接', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toMatch(/<a[^>]*href="javascript:/i);
    expect(html).not.toMatch(/<a[^>]*href='javascript:/i);
  });

  it('markdown 链接 [text](vbscript:...) → 没有真 vbscript: 链接', () => {
    const html = renderMarkdown('[click](vbscript:msgbox(1))');
    expect(html).not.toMatch(/<a[^>]*href="vbscript:/i);
  });

  it('markdown 链接 [text](data:text/html,...) → 没有真 data:text/html 链接', () => {
    const html = renderMarkdown('[click](data:text/html,<script>alert(1)</script>)');
    expect(html).not.toMatch(/<a[^>]*href="data:text\/html/i);
  });

  it('https: / http: / mailto: 允许通过（正常链接）', () => {
    expect(renderMarkdown('[a](https://ok.com)')).toContain('href="https://ok.com"');
    expect(renderMarkdown('[a](http://ok.com)')).toContain('href="http://ok.com"');
    expect(renderMarkdown('[a](mailto:x@y.com)')).toContain('mailto:x@y.com');
  });
});

describe('renderPlain', () => {
  it('空 / null → 空字符串', () => {
    expect(renderPlain('')).toBe('');
    expect(renderPlain(null)).toBe('');
  });

  it('换行转 <br>', () => {
    const html = renderPlain('a\nb');
    expect(html).toContain('<br>');
  });

  it('不解析 markdown（**bold** 应保留为字面量）', () => {
    const html = renderPlain('**bold**');
    // renderPlain 走 DOMPurify sanitize + replace \n → <br>
    // markdown 标记应被转义（**变 * 或 &ast;），不会成 <strong>
    expect(html).not.toContain('<strong>');
  });
});
