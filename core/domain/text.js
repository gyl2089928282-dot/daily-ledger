/**
 * 文本工具。
 *
 * esc() 是这一份代码里唯一的转义实现：界面拼接 HTML、规则生成结论都用它。
 * stripTags() 给非 HTML 消费者用（比如定时任务把结论排成纯文本）。
 */

/** 转义成可安全插入 HTML 的文本 */
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 去掉规则里使用的轻量标记（目前只有 <b>），并还原实体。
 * 给短信 / 纯文本推送这类消费者用。
 */
export function stripTags(s) {
  return String(s == null ? "" : s)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
