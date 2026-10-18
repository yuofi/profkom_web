import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { insertMarkdown } from "./markdown";
import { MarkdownContent } from "../components/Workspace/MarkdownContent";
it("renders bold, italic, links, lists and line breaks without raw HTML execution", () => {
  const html = renderToStaticMarkup(
    <MarkdownContent
      body={
        "**Жирный** и *курсив*\nПеренос\n\n- [Ссылка](https://example.com)\n\n<script>alert(1)</script>"
      }
    />,
  );
  expect(html).toContain("<strong>Жирный</strong>");
  expect(html).toContain("<em>курсив</em>");
  expect(html).toContain("<br/>");
  expect(html).toContain("<li>");
  expect(html).not.toContain("<script>");
});
it("inserts formatting without rewriting gallery/contact fences or whitespace", () => {
  const custom =
    "\n\n```gallery\n/avatars/sun.svg | Подпись\n```\n\n```chip\nФамилия: Смирнова\nИмя: Анна\n```\n";
  const source = "Текст" + custom;
  const edited = insertMarkdown(source, 0, 5, "**", "**");
  expect(edited).toBe("**Текст**" + custom);
});
