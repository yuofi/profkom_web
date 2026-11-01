import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { RichText } from "../../utils/api/contract";
import s from "./Workspace.module.css";

/** Plain Markdown of a workspace page. Its own module: only the pages that show it load the
 *  Markdown parser, not the first download of every page (PF-11). */
export const Markdown = ({
  content,
  preview = false,
}: {
  content: RichText | string | null | undefined;
  /** Only the beginning, for a card in a list. */
  preview?: boolean;
}) => (
  <div className={clsx(s.markdown, preview && s.preview)}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
      {typeof content === "string" ? content : (content?.body ?? "")}
    </ReactMarkdown>
  </div>
);
