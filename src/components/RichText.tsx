import { Fragment, type ReactNode } from 'react';

/**
 * 极简富文本渲染：支持 **加粗**、`行内代码` 与换行。
 * 刻意不引入 markdown 依赖、不使用 dangerouslySetInnerHTML。
 */
export function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {inline(line)}
        </Fragment>
      ))}
    </>
  );
}

function inline(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) {
      out.push(<strong key={k++}>{token.slice(2, -2)}</strong>);
    } else {
      out.push(<code key={k++}>{token.slice(1, -1)}</code>);
    }
    last = m.index + token.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}
