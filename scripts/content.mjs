const privateKey = /^(?:reasoning(?:_content)?|thinking|signature|authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

function redact(text) {
  return text.replace(/<(?:think|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis)>/gi, '[reasoning omitted]')
    .replace(/\b(?:sk-(?:lf-)?[\w-]{8,}|Bearer\s+[\w.\/-]{8,})/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[PRIVATE KEY OMITTED]')
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '[HOME]');
}

export function sanitizeContent(value, maxChars = 16000) {
  let redacted = false;
  const clean = (item, depth = 0) => {
    if (depth > 20) { redacted = true; return '[depth limit]'; }
    if (typeof item === 'string') { const text = redact(item); redacted ||= text !== item; return text; }
    if (Array.isArray(item)) return item.map(child => clean(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (privateKey.test(key)) { redacted = true; return [key, '[REDACTED]']; }
      return [key, clean(child, depth + 1)];
    }));
    return item;
  };
  const cleaned = clean(value);
  const text = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned);
  if (text === undefined) return { value: null, redacted, truncated: false };
  const truncated = text.length > maxChars;
  return { value: truncated ? `${text.slice(0, maxChars)}\n[truncated]` : cleaned, redacted, truncated,
    ...(truncated ? { originalChars: text.length } : {}) };
}

export function visibleText(content, role) {
  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : [content])
    .filter(part => part && ['text', 'input_text', 'output_text'].includes(part.type))
    .map(part => part.text || '').join('\n');
  if (role !== 'user') return text;
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map(match => match[1]);
  return queries.length ? queries.join('\n') : text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '').trim();
}
