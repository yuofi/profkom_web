import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Gallery } from "../Gallery/Gallery";
import { ContactChip } from "../ContactChip/ContactChip";
import { apiUrl } from "../../utils/api";
import s from "./Workspace.module.css";
export function MarkdownContent({ body }: { body: string }) {
  return (
    <div className={s.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // Files of a material are API addresses, checked on every request (decision 23).
        urlTransform={(url) => defaultUrlTransform(apiUrl(url))}
        components={{
          pre: ({ children, node }) => {
            const extension = node?.children.some(
              (n) =>
                n.type === "element" &&
                n.tagName === "code" &&
                Array.isArray(n.properties.className) &&
                n.properties.className.some(
                  (c) => c === "language-gallery" || c === "language-chip",
                ),
            );
            return extension ? <div>{children}</div> : <pre>{children}</pre>;
          },
          code: ({ className, children }) =>
            className === "language-gallery" ? (
              <Gallery
                initialContent={String(children).replace(/\n$/, "")}
                mode="view"
              />
            ) : className === "language-chip" ? (
              <ContactChip
                initialContent={String(children).replace(/\n$/, "")}
                mode="view"
              />
            ) : (
              <code className={className}>{children}</code>
            ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
