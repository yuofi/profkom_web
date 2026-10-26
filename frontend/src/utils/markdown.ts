/** Source edits never parse/reserialize the rest of a document or its custom fences. */
export function insertMarkdown(
  source: string,
  start: number,
  end: number,
  before: string,
  after = "",
) {
  return (
    source.slice(0, start) +
    before +
    source.slice(start, end) +
    after +
    source.slice(end)
  );
}

/** Change only complete selected lines; a selection ending at a line boundary excludes the next line. */
export function transformMarkdownLines(source: string, start: number, end: number, transform: (line: string, index: number) => string) {
  const first = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
  const boundary = end > start && source[end - 1] === "\n" ? end - 1 : end;
  const nextLine = source.indexOf("\n", boundary);
  const last = nextLine < 0 ? source.length : nextLine;
  const content = source.slice(first, last).split("\n").map(transform).join("\n");
  return { value: source.slice(0, first) + content + source.slice(last), start: first, end: first + content.length };
}
