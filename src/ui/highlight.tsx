/**
 * Tiny clean-room syntax highlighter for terminal code blocks. Tokenizes a line into
 * colored Ink <Text> segments (NOT raw ANSI — Ink measures text width itself). Language-
 * agnostic: comments, strings, numbers, and a common keyword set across JS/TS/Py/Go/Rust.
 */
import { Text } from "ink";
import type { ReactNode } from "react";

const KEYWORDS = new Set(
  (
    "const let var function func fn def return if else elif for while do switch case break " +
    "continue import export from as class struct interface type enum impl trait new async await " +
    "yield public private protected static void extends implements package use pub mut match in " +
    "of is true false null nil None True False undefined self this super throw try catch finally " +
    "with lambda go defer chan"
  ).split(" "),
);

export function highlightLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = "";
  let key = 0;
  let i = 0;
  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = "";
    }
  };

  while (i < line.length) {
    const rest = line.slice(i);

    const comment = rest.match(/^(\/\/.*|#.*)/);
    if (comment) {
      flush();
      out.push(<Text key={key++} color="gray">{comment[0]}</Text>);
      break;
    }

    const str = rest.match(/^("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)/);
    if (str && /^["'`]/.test(str[0])) {
      flush();
      out.push(<Text key={key++} color="green">{str[0]}</Text>);
      i += str[0].length;
      continue;
    }

    const num = rest.match(/^\d[\d_]*(\.\d+)?/);
    if (num) {
      flush();
      out.push(<Text key={key++} color="yellow">{num[0]}</Text>);
      i += num[0].length;
      continue;
    }

    const id = rest.match(/^[A-Za-z_]\w*/);
    if (id) {
      if (KEYWORDS.has(id[0])) {
        flush();
        out.push(<Text key={key++} color="magenta">{id[0]}</Text>);
      } else {
        plain += id[0];
      }
      i += id[0].length;
      continue;
    }

    plain += line[i];
    i++;
  }

  flush();
  return out.length ? out : [line];
}
