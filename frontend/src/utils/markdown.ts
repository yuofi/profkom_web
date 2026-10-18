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
