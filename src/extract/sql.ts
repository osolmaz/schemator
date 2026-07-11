import type { FieldNode, ModelNode, SourceSpan } from "../types.js";

type Statement = {
  text: string;
  startLine: number;
  endLine: number;
};

type ColumnDefinition = {
  text: string;
  startLine: number;
  endLine: number;
};

const tableConstraintKeywords = new Set([
  "constraint",
  "primary",
  "foreign",
  "unique",
  "check",
  "exclude",
  "key",
  "index",
  "fulltext",
  "spatial",
]);

const columnConstraintKeywords = new Set([
  "not",
  "null",
  "default",
  "primary",
  "unique",
  "references",
  "check",
  "constraint",
  "collate",
  "generated",
  "identity",
  "comment",
  "encode",
  "compress",
]);

export function extractSqlModels(sql: string, sourcePath: string, startLine = 1): ModelNode[] {
  return splitSqlStatements(sql, startLine).flatMap((statement) => extractCreateTable(statement, sourcePath));
}

function extractCreateTable(statement: Statement, sourcePath: string): ModelNode[] {
  const match = /create\s+(?:temporary\s+|temp\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([^\s(]+)\s*\(/i.exec(
    statement.text,
  );
  if (!match || match.index === undefined) {
    return [];
  }

  const tableName = normalizeIdentifier(match[1] ?? "Table");
  const tableStartLine = statement.startLine + countNewlines(statement.text.slice(0, match.index));
  const openParen = statement.text.indexOf("(", match.index);
  const closeParen = findMatchingParen(statement.text, openParen);
  if (openParen < 0 || closeParen < 0) {
    return [];
  }

  const body = statement.text.slice(openParen + 1, closeParen);
  const bodyStartLine = statement.startLine + countNewlines(statement.text.slice(0, openParen + 1));
  const fields = splitColumnDefinitions(body, bodyStartLine)
    .map((definition) => columnToField(definition, tableName, sourcePath))
    .filter((field): field is FieldNode => field !== null);

  return fields.length > 0
    ? [
        {
          id: tableName,
          kind: "table",
          source: {
            path: sourcePath,
            span: { startLine: tableStartLine, endLine: statement.endLine },
          },
          fields,
        },
      ]
    : [];
}

function columnToField(definition: ColumnDefinition, tableName: string, sourcePath: string): FieldNode | null {
  const stripped = stripLeadingSqlComments(definition.text);
  const trimmed = stripped.text.trim();
  if (!trimmed) {
    return null;
  }
  const [rawName, rest] = readIdentifier(trimmed);
  if (!rawName || tableConstraintKeywords.has(rawName.toLowerCase())) {
    return null;
  }
  const name = normalizeIdentifier(rawName);
  const type = readColumnType(rest.trim());
  const lower = trimmed.toLowerCase();
  const required = /\bnot\s+null\b/.test(lower) || /\bprimary\s+key\b/.test(lower);
  return {
    path: name,
    name,
    type,
    required,
    nullable: !required,
    parent: tableName,
    objectLike: false,
    source: {
      path: sourcePath,
      span: { startLine: definition.startLine + stripped.lineDelta, endLine: definition.endLine },
    },
  };
}

function stripLeadingSqlComments(text: string): { text: string; lineDelta: number } {
  let rest = text;
  let lineDelta = 0;
  const trimLeading = (): void => {
    const trimmed = rest.trimStart();
    lineDelta += countNewlines(rest.slice(0, rest.length - trimmed.length));
    rest = trimmed;
  };
  trimLeading();
  let changed = true;
  while (changed) {
    changed = false;
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      const removed = newline === -1 ? rest : rest.slice(0, newline + 1);
      rest = newline === -1 ? "" : rest.slice(newline + 1);
      lineDelta += countNewlines(removed);
      trimLeading();
      changed = true;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      const removed = end === -1 ? rest : rest.slice(0, end + 2);
      rest = end === -1 ? "" : rest.slice(end + 2);
      lineDelta += countNewlines(removed);
      trimLeading();
      changed = true;
    }
  }
  return { text: rest, lineDelta };
}

function readColumnType(rest: string): string {
  const tokens = rest.match(/"[^"]+"|'[^']+'|`[^`]+`|\[[^\]]+\]|\S+/g) ?? [];
  const typeTokens: string[] = [];
  let parenDepth = 0;
  for (const token of tokens) {
    const bare = token.replace(/[(),]/g, "").toLowerCase();
    if (parenDepth === 0 && columnConstraintKeywords.has(bare)) {
      break;
    }
    typeTokens.push(token);
    parenDepth += countChar(token, "(") - countChar(token, ")");
  }
  return typeTokens.join(" ").trim() || "unknown";
}

function splitSqlStatements(sql: string, startLine: number): Statement[] {
  const statements: Statement[] = [];
  let start = 0;
  let line = startLine;
  let statementStartLine = startLine;
  let singleQuote = false;
  let doubleQuote = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "\n") {
      line += 1;
      lineComment = false;
    }
    if (lineComment) {
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!singleQuote && !doubleQuote && char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!singleQuote && !doubleQuote && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (!doubleQuote && char === "'" && sql[index - 1] !== "\\") {
      singleQuote = !singleQuote;
    } else if (!singleQuote && char === '"') {
      doubleQuote = !doubleQuote;
    }
    if (!singleQuote && !doubleQuote && char === ";") {
      const text = sql.slice(start, index + 1).trim();
      if (text) {
        statements.push({ text, startLine: firstContentLine(sql.slice(start, index + 1), 0, statementStartLine), endLine: line });
      }
      start = index + 1;
      statementStartLine = line;
    }
  }

  const text = sql.slice(start).trim();
  if (text) {
    statements.push({ text, startLine: firstContentLine(sql.slice(start), 0, statementStartLine), endLine: line });
  }
  return statements;
}

function splitColumnDefinitions(body: string, startLine: number): ColumnDefinition[] {
  const columns: ColumnDefinition[] = [];
  let start = 0;
  let line = startLine;
  let parenDepth = 0;
  let singleQuote = false;
  let doubleQuote = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    const next = body[index + 1];
    if (char === "\n") {
      line += 1;
      lineComment = false;
    }
    if (lineComment) {
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!singleQuote && !doubleQuote && char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!singleQuote && !doubleQuote && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (!doubleQuote && char === "'" && body[index - 1] !== "\\") {
      singleQuote = !singleQuote;
    } else if (!singleQuote && char === '"') {
      doubleQuote = !doubleQuote;
    }
    if (singleQuote || doubleQuote) {
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    } else if (char === "," && parenDepth === 0) {
      const text = body.slice(start, index).trim();
      if (text) {
        columns.push({ text, startLine: firstContentLine(body, start, startLine), endLine: line });
      }
      start = index + 1;
    }
  }
  const text = body.slice(start).trim();
  if (text) {
    columns.push({ text, startLine: firstContentLine(body, start, startLine), endLine: line });
  }
  return columns;
}

function findMatchingParen(text: string, openParen: number): number {
  let depth = 0;
  let singleQuote = false;
  let doubleQuote = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openParen; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\n") {
      lineComment = false;
    }
    if (lineComment) {
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!singleQuote && !doubleQuote && char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!singleQuote && !doubleQuote && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (!doubleQuote && char === "'" && text[index - 1] !== "\\") {
      singleQuote = !singleQuote;
    } else if (!singleQuote && char === '"') {
      doubleQuote = !doubleQuote;
    }
    if (singleQuote || doubleQuote) {
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function readIdentifier(text: string): [string | null, string] {
  const trimmed = text.trimStart();
  const quoted = /^("[^"]+"|`[^`]+`|\[[^\]]+\])\s*(.*)$/s.exec(trimmed);
  if (quoted) {
    return [quoted[1] ?? null, quoted[2] ?? ""];
  }
  const bare = /^([^\s]+)\s*(.*)$/s.exec(trimmed);
  return [bare?.[1] ?? null, bare?.[2] ?? ""];
}

function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim().replace(/^["`\[]|["`\]]$/g, "");
  const parts = trimmed.split(".");
  return parts[parts.length - 1] ?? trimmed;
}

function firstContentLine(text: string, startOffset: number, baseLine: number): number {
  const rest = text.slice(startOffset);
  const leadingWhitespace = /^\s*/.exec(rest)?.[0] ?? "";
  return baseLine + countNewlines(text.slice(0, startOffset)) + countNewlines(leadingWhitespace);
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function countChar(text: string, char: string): number {
  return [...text].filter((candidate) => candidate === char).length;
}
