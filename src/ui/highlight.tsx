/**
 * Tiny clean-room syntax highlighter for terminal code blocks. Tokenizes a line into
 * colored Ink <Text> segments (NOT raw ANSI — Ink measures text width itself). Language-
 * agnostic: comments, strings, numbers, and a common keyword set across JS/TS/Py/Go/Rust.
 */
import { Text } from "ink";
import { cloneElement, isValidElement, type ReactNode } from "react";

const KEYWORDS = new Set(
  (
    "const let var function func fn def return if else elif for while do switch case break " +
    "continue import export from as class struct interface type enum impl trait new async await " +
    "yield public private protected static extends implements package use pub mut match in " +
    "of is true false null nil None True False undefined self this super throw try catch finally " +
    "with lambda go defer chan"
  ).split(" "),
);

// Built-in/primitive TYPES color like class/type names (cyan) - matches how Claude Code renders types.
const TYPES = new Set("void string number boolean bigint symbol object any unknown never Promise Record Array Map Set".split(" "));
// Language constants / literals get their own accent (bright yellow) - true/false/null read as VALUES,
// not keywords, matching editor themes.
const LITERALS = new Set("true false null nil None True False undefined void NaN Infinity self this super".split(" "));

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
      const s = str[0];
      // Template literals: highlight `${expr}` interpolations as CODE (the way editors + Claude Code do)
      // instead of dyeing the whole backtick string one flat color. The braces are dim; the inner
      // expression is recursively highlighted. Plain "/' strings stay one green token.
      if (s[0] === "`" && s.includes("${")) {
        for (const part of s.split(/(\$\{[^}]*\})/)) {
          if (!part) continue;
          const interp = part.match(/^\$\{([^}]*)\}$/);
          if (interp) {
            out.push(<Text key={key++} dimColor>{"${"}</Text>);
            for (const node of highlightLine(interp[1])) {
              out.push(isValidElement(node) ? cloneElement(node, { key: key++ }) : <Text key={key++}>{node}</Text>);
            }
            out.push(<Text key={key++} dimColor>{"}"}</Text>);
          } else {
            out.push(<Text key={key++} color="green">{part}</Text>);
          }
        }
      } else {
        out.push(<Text key={key++} color="green">{s}</Text>);
      }
      i += s.length;
      continue;
    }

    const num = rest.match(/^\d[\d_]*(\.\d+)?/);
    if (num) {
      flush();
      out.push(<Text key={key++} color="yellow">{num[0]}</Text>);
      i += num[0].length;
      continue;
    }

    const id = rest.match(/^[A-Za-z_$][\w$]*/);
    if (id) {
      const word = id[0];
      const after = rest.slice(word.length);
      // Color, in priority order (matches how editor/Claude themes read): literal value (bright yellow)
      // > keyword (magenta) > type/Capitalized-or-builtin (cyan) > function call, i.e. immediately
      // followed by "(" (blue) > property after a "." (subtle) > plain. Per-token coloring makes a diff
      // read like real code, not one flat green.
      const before = i > 0 ? line[i - 1] : ""; // the char just before this identifier (for "foo.bar")
      if (LITERALS.has(word)) {
        flush();
        out.push(<Text key={key++} color="yellowBright">{word}</Text>);
      } else if (KEYWORDS.has(word)) {
        flush();
        out.push(<Text key={key++} color="magenta">{word}</Text>);
      } else if (TYPES.has(word) || /^[A-Z]/.test(word)) {
        flush();
        out.push(<Text key={key++} color="cyan">{word}</Text>);
      } else if (after.startsWith("(")) {
        flush();
        out.push(<Text key={key++} color="blue">{word}</Text>);
      } else if (before === ".") {
        flush();
        out.push(<Text key={key++} color="cyanBright">{word}</Text>); // property access (foo.BAR)
      } else {
        plain += word;
      }
      i += word.length;
      continue;
    }

    plain += line[i];
    i++;
  }

  flush();
  return out.length ? out : [line];
}
