import type { Root, RootContent } from "mdast";

/** The journal compiler treats bare URLs/emails as prose. GFM otherwise creates
 * http/mailto links only in the browser; unwrap those, retaining explicit links. */
export function journalMarkdown({ source }: { source: string }) {
  return (tree: Root) => {
    const visit = (parent: Root | RootContent) => {
      if (!("children" in parent)) return;
      const children = parent.children as RootContent[];
      children.forEach((node, index) => {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (node.type === "link" && start !== undefined && end !== undefined && !["[", "<"].includes(source[start])) {
          children[index] = { type: "text", value: source.slice(start, end), position: node.position };
        } else visit(node);
      });
    };
    visit(tree);
  };
}
