import { t as tx } from "../i18n";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : null;
  } catch { return null; }
}
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(start, match.index));
    const value = match[0], key = match.index;
    if (value.startsWith("`")) parts.push(<code key={key}>{value.slice(1, -1)}</code>);
    else if (value.startsWith("**")) parts.push(<strong key={key}>{value.slice(2, -2)}</strong>);
    else {
      const link = value.match(/^\[([^\]]+)\]\((.+)\)$/)!;
      const href = safeLink(link[2]);
      parts.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{link[1]}</a> : value);
    }
    start = match.index! + value.length;
  }
  parts.push(text.slice(start));
  return parts;
}
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n"), blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const key = i;
    if (lines[i].startsWith("```")) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push(<pre key={key}><code>{code.join("\n")}</code></pre>);
    } else if (/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) {
      const ordered = /^\s*\d+\./.test(lines[i]), items: ReactNode[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>);
      }
      blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
    } else if (!lines[i].trim()) i++;
    else {
      const paragraph: string[] = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !/^(?:```|\s*(?:[-*]|\d+\.)\s+)/.test(lines[i])) paragraph.push(lines[i++]);
      blocks.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
    }
  }
  return <>{blocks}</>;
}
export function MessageBody({ text, markdown }: { text: string; markdown: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false), [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = body.current!;
    const measure = () => setLong(el.scrollHeight > parseFloat(getComputedStyle(el).lineHeight) * 12 + 2);
    const observer = new ResizeObserver(measure); observer.observe(el); measure();
    return () => observer.disconnect();
  }, [text]);
  return <>
    <div ref={body} className={`message-body ${long && !expanded ? "folded" : ""}`}>
      {markdown ? <Markdown text={text} /> : <p>{text}</p>}
    </div>
    {long && <button type="button" className="message-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? tx("Daha az göster") : tx("Devamını göster")}
    </button>}
  </>;
}
