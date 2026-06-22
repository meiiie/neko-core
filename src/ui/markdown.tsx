/**
 * A small clean-room markdown renderer for the terminal (Ink). Handles code fences,
 * headings, bullet/numbered lists, and inline **bold** / *italic* / `code`. Kept ASCII-safe
 * (no fancy glyphs) so it renders on any Windows console codepage.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[2] !== undefined) out.push(<Text key={key++} bold>{m[2]}</Text>);
    else if (m[3] !== undefined) out.push(<Text key={key++} color="yellow">{m[3]}</Text>);
    else if (m[4] !== undefined) out.push(<Text key={key++} italic>{m[4]}</Text>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.length ? out : [s];
}

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <Box key={key++} flexDirection="column" paddingLeft={2}>
          {code.map((c, j) => (
            <Text key={j} color="gray">{c.length ? c : " "}</Text>
          ))}
        </Box>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(<Text key={key++} bold color="cyan">{heading[2]}</Text>);
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push(<Text key={key++}>{bullet[1]}- {inline(bullet[2])}</Text>);
      i++;
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (numbered) {
      blocks.push(<Text key={key++}>{numbered[1]}{numbered[2]}. {inline(numbered[3])}</Text>);
      i++;
      continue;
    }

    blocks.push(<Text key={key++}>{inline(line)}</Text>);
    i++;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
