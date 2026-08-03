import React, { useState, useEffect, useMemo, type ReactNode, isValidElement } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {useMe} from "../../utils/me";
import { generateSlug, extractToc } from "../../utils/idGen";
import { guidesApi } from "../../utils/api/guides.api";
import { blocksApi } from "../../utils/api/blocks.api";
import { getDocEditRoute } from "../../utils/routes";
import { Icon } from "../../components/Icon";
import { Gallery } from "../../components/Gallery/Gallery";

import styles from "./DocViewerPage.module.css";
import { ContactChip } from "../../components/ContactChip/ContactChip";
import { Helmet } from "react-helmet-async";
import { canEditGuide } from "../../utils/filterRoles";

const extractTextFromChildren = (children: ReactNode): string => {
  if (typeof children === "string") return children;
  if (typeof children === "number") return children.toString();
  if (Array.isArray(children))
    return children.map(extractTextFromChildren).join("");
  if (isValidElement<{ children?: ReactNode }>(children) && children.props.children) {
    return extractTextFromChildren(children.props.children as ReactNode);
  }
  return "";
};

export const DocViewerPage = () => {
  const user = useMe();
  const [activeId, setActiveId] = useState<string>("");
  const { id } = useParams<{ id: string }>();

  const {
    data: guide,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ["guide", id, user?.user_id ?? "anon"],
    queryFn: () => guidesApi.getById(id!),
    enabled: !!id,
    retry: false,
  });

  const { data: blocks } = useQuery({
    queryKey: ["blocks"],
    queryFn: blocksApi.getAll,
    enabled: !!user,
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


  const markdownComponents: Components = useMemo(() => {
    return {
      h2(props: React.ComponentPropsWithoutRef<"h2"> & ExtraProps) {
        const { node, children, ...rest } = props;
        void node;
        const headingText = extractTextFromChildren(children);
        const slugId = generateSlug(headingText);

        return (
          <h2 id={slugId} {...rest}>
            {children}
          </h2>
        );
      },
      pre(props: React.ComponentPropsWithoutRef<"pre"> & ExtraProps) {
        const { node, children, ...rest } = props;
        void node;
        
        // Если все дочерние элементы вернули null (скрытые чипы), скрываем и сам контейнер
        const childrenArray = React.Children.toArray(children);
        if (childrenArray.length === 0 || childrenArray.every(child => child === null || (isValidElement(child) && child.type === React.Fragment && !React.Children.count((child.props as { children?: ReactNode }).children)))) {
          return null;
        }

        // Проверяем, не чип ли это внутри или галерея
        const isChip = childrenArray.some((child) => 
          isValidElement<{ className?: string; children?: ReactNode }>(child) && (
            child.props.className?.includes('language-chip') || 
            (isValidElement<{ className?: string }>(child.props.children) && child.props.children.props.className?.includes('language-chip'))
          )
        );

        const isGallery = childrenArray.some((child) => 
          isValidElement<{ className?: string; children?: ReactNode }>(child) && (
            child.props.className?.includes('language-gallery') || 
            (isValidElement<{ className?: string }>(child.props.children) && child.props.children.props.className?.includes('language-gallery'))
          )
        );

        if (isChip || isGallery) {
          return <div className={isChip ? styles.chipBlock : styles.galleryBlock}>{children}</div>;
        }

        return <pre {...rest}>{children}</pre>;
      },
      code(props: React.ComponentPropsWithoutRef<"code"> & ExtraProps) {
        const { node, children, className, ...rest } = props;
        void node;

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
  if (isError) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (error as any)?.response?.status;
    if (status === 403) {
      return <div className={styles.container}>Доступ к данному документу ограничен.</div>;
    }
    return <div className={styles.container}>Ошибка при загрузке данных.</div>;
  }
  if (!guide)
    return <div className={styles.container}>Документ не найден.</div>;


  return (
    <div className={styles.container}>
      <Helmet>
        <title>{guide ? `${guide.title} | Профком ВМК` : "База знаний | Профком ВМК"}</title>
      </Helmet>
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
      
      {canEditGuide(guide, user, blocks) && (
      <Link 
        to={getDocEditRoute(guide.guide_id)} 
        className={styles.editFab}
        title="Редактировать"
      >
        <Icon name="edit" size={24} />
      </Link>
    )}
    </div>
    
  );
};
