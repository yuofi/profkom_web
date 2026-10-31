/** Formula rendering, loaded only for Markdown that contains `$` (KaTeX and its fonts are heavy). */
import "katex/dist/katex.min.css";
export { default as remarkMath } from "remark-math";
export { default as rehypeKatex } from "rehype-katex";
