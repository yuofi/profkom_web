import { useState, useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { SwiperSlide, Swiper } from "swiper/react";
import { Navigation, Pagination } from "swiper/modules";

import { generateSlug, extractToc } from "../../utils/idGen";
import { api } from "../../utils/api";
import styles from "./DocViewerPage.module.css";

import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";

interface Toc {
  id: string;
  title: string;
  isActive: boolean;
}

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
  // const [toc, setToc] = useState<Toc[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  const { id } = useParams<{ id: string }>();

  // 2. Загружаем и фильтруем гайды через React Query
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
    select: (allGuides) => {
      // id из URL всегда строка, переводим в Number
      return allGuides.find((g) => g.guide_id === Number(id));
    },
  });

  const toc = useMemo(() => {
    if (!guide || !guide.text) return [];
    return extractToc(guide.text);
  }, [guide]);

  // 4. Отслеживание скролла
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
      code(props: any) {
        const { children, className, node, ...rest } = props;
        const match = /language-(\w+)/.exec(className || "");

        if (match && match[1] === "gallery") {
          const content = String(children).replace(/\n$/, "");
          const lines = content.split("\n");

          return (
            <div className={styles.carouselContainer}>
              <Swiper
                modules={[Navigation, Pagination]}
                navigation
                pagination={{ clickable: true }}
                spaceBetween={20}
                slidesPerView={1}
              >
                {lines.map((line, index) => {
                  const [src, caption] = line.split("|");
                  return (
                    <SwiperSlide key={index}>
                      <figure className={styles.carouselFigure}>
                        <img
                          src={src.trim()}
                          alt={caption?.trim() || "Слайд"}
                        />
                        {caption && <figcaption>{caption.trim()}</figcaption>}
                      </figure>
                    </SwiperSlide>
                  );
                })}
              </Swiper>
            </div>
          );
        }

        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      },
    };
  }, []);

  // Обработка состояний загрузки и отсутствия данных
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
          {/* 5. ПРАВИЛЬНО: Рендерим текст напрямую из объекта guide */}
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={markdownComponents}
          >
            {guide.text}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
};
