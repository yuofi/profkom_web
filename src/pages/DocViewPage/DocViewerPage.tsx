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
import { ContactChip, type ContactInfo } from "../../components/ContactChip/ContactChip";
import { ContactDirectory, type FilterCriteria } from "../../components/ContactDirectory/ContactPage";
import { parseContent } from "../../utils/parsing";
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

const matchesFilters = (info: ContactInfo, filters: FilterCriteria[]): boolean => {
  if (filters.length === 0) return true;

  return filters.every((filter) => {
    const value = info[filter.field]?.toLowerCase() || "";
    const search = filter.value.toLowerCase();

    // Обработка диапазона для группы (напр. 101-105)
    if (filter.field === 'group' && search.includes('-')) {
      const [minStr, maxStr] = search.split('-');
      const min = parseInt(minStr);
      const max = parseInt(maxStr);
      const current = parseInt(value);
      
      if (!isNaN(min) && !isNaN(max) && !isNaN(current)) {
        return current >= min && current <= max;
      }
    }

    return value.includes(search);
  });
};

export const DocViewerPage = () => {
  const [activeId, setActiveId] = useState<string>("");
  const [activeFilters, setActiveFilters] = useState<FilterCriteria[]>([]);
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


  const { cleanText, isDirectory } = useMemo(() => {
    if (!guide?.text) return { cleanText: "", isDirectory: false };

    let text = guide.text;
    let isDir = false;

    // Регулярка для поиска filter=true в начале файла (игнорируя BOM и пробелы)
    const filterRegex = /^\s*filter\s*=\s*true\s*(\r?\n)?/;
    const match = text.match(filterRegex);

    if (match) {
      isDir = true;
      text = text.replace(filterRegex, "");
    }

    return { cleanText: text, isDirectory: isDir };
  }, [guide]);

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

        // Проверяем, не чип ли это внутри
        const isChip = childrenArray.some((child: any) => 
          child?.props?.className?.includes('language-chip') || 
          (child?.props?.children?.props?.className?.includes('language-chip'))
        );

        if (isChip) {
          return <div className={styles.chipBlock}>{children}</div>;
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
          
          if (isDirectory) {
            const info = parseContent(content);
            if (!matchesFilters(info, activeFilters)) {
              return null;
            }
          }
          
          return <ContactChip initialContent={content} mode="view" />;
        }

        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      },
    };
  }, [isDirectory, activeFilters]);

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
            {cleanText}
          </ReactMarkdown>
        </div>
      </article>

      {isDirectory && (
        <aside className={styles.rightSidebar}>
          <ContactDirectory 
            activeFilters={activeFilters} 
            onFiltersChange={setActiveFilters} 
          />
        </aside>
      )}

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
