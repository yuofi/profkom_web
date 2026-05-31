import { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

import { generateSlug, extractToc } from "../../utils/idGen";
import { api } from "../../utils/api";
import { getDocEditRoute } from "../../utils/routes";
import { Icon } from "../../components/Icon";
import { Gallery } from "../../components/Gallery/Gallery";

import styles from "./DocViewerPage.module.css";
import { ContactChip } from "../../components/ContactChip/ContactChip";
import React from "react";

interface GuideOut {
  title: string;
  owner_block: string;
  text: string;
  origingal_link?: string;
  guide_id: number;
}

const extractTextFromChildren = (children: any): string => {
  if (typeof children === "string") return children;
  if (typeof children === "number") return children.toString();
  if (Array.isArray(children))
    return children.map(extractTextFromChildren).join("");
  if (children && children.props && children.props.children) {
    return extractTextFromChildren(children.props.children);
  }
  return "";
};

export const DocViewerPage = () => {
  const [activeId, setActiveId] = useState<string>("");
  const { id } = useParams<{ id: string }>();

  const {
    data: guide,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["guides"],
    queryFn: async () => {
      const response = await api.get<GuideOut[]>("/guides");
      return response.data;
    },
    staleTime: 10 * 60 * 1000,
    select: (allGuides) => allGuides.find((g) => g.guide_id === Number(id)),
  });

  const toc = useMemo(() => {
    if (!guide || !guide.text) return [];
    return extractToc(guide.text);
  }, [guide]);

  useEffect(() => {
    if (!guide?.text || toc.length === 0) return;

    const handleScroll = () => {
      const headings = Array.from(
        document.querySelectorAll(`.${styles.markdownWrapper} h2[id]`),
      );
      const offset = 120;

      const passedHeadings = headings.filter(
        (heading) => heading.getBoundingClientRect().top <= offset,
      );

      if (passedHeadings.length > 0) {
        const currentId = passedHeadings[passedHeadings.length - 1].id;
        setActiveId(currentId);
      } else {
        setActiveId(toc[0].id);
      }
    };

    window.addEventListener("scroll", handleScroll);
    handleScroll();

    return () => {
      window.removeEventListener("scroll", handleScroll);
    };
  }, [guide?.text, toc]);


  const markdownComponents = useMemo(() => {
    return {
      h2(props: any) {
        const { node, children, ...rest } = props;
        const headingText = extractTextFromChildren(children);
        const slugId = generateSlug(headingText);

        return (
          <h2 id={slugId} {...rest}>
            {children}
          </h2>
        );
      },
      pre(props: any) {
        const { children, ...rest } = props;
        
        // Если все дочерние элементы вернули null (скрытые чипы), скрываем и сам контейнер
        const childrenArray = React.Children.toArray(children);
        if (childrenArray.length === 0 || childrenArray.every(child => child === null || (typeof child === 'object' && child !== null && 'type' in child && child.type === React.Fragment && !React.Children.count((child as any).props.children)))) {
          return null;
        }

        // Проверяем, не чип ли это внутри или галерея
        const isChip = childrenArray.some((child: any) => 
          child?.props?.className?.includes('language-chip') || 
          (child?.props?.children?.props?.className?.includes('language-chip'))
        );

        const isGallery = childrenArray.some((child: any) => 
          child?.props?.className?.includes('language-gallery') || 
          (child?.props?.children?.props?.className?.includes('language-gallery'))
        );

        if (isChip || isGallery) {
          return <div className={isChip ? styles.chipBlock : styles.galleryBlock}>{children}</div>;
        }

        return <pre {...rest}>{children}</pre>;
      },
      code(props: any) {
        const { children, className, node, ...rest } = props;
        const match = /language-(\w+)/.exec(className || "");


        if (match && match[1] === "gallery") {
          const content = String(children).replace(/\n$/, "");
          return <Gallery initialContent={content} mode="view" />;
        }

        if (match && match[1] === "chip") {
          const content = String(children).replace(/\n$/, "");
          
          return <ContactChip initialContent={content} mode="view" />;
        }

        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      },
    };
  }, []);

  if (isLoading)
    return <div className={styles.container}>Загрузка документа...</div>;
  if (isError)
    return <div className={styles.container}>Ошибка при загрузке данных.</div>;
  if (!guide)
    return <div className={styles.container}>Документ не найден.</div>;

  return (
    <div className={styles.container}>
      <aside className={styles.sidebar}>
          <ul className={styles.navLinks}>
            {toc.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className={`${styles.navLink} ${item.id === activeId ? styles.active : ""}`}
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
      </aside>

      <article className={styles.mainContent}>
        <div className={styles.markdownWrapper}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={markdownComponents}
          >
            {guide.text}
          </ReactMarkdown>
        </div>
      </article>

      <Link 
        to={getDocEditRoute(guide.guide_id)} 
        className={styles.editFab}
        title="Редактировать"
      >
        <Icon name="edit" size={24} />
      </Link>
    </div>
  );
};
