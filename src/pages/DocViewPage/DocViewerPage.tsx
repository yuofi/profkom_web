import { useState, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { generateSlug, extractToc } from "../../utils/idGen";
import styles from "./DocViewerPage.module.css";
import { SwiperSlide, Swiper } from "swiper/react";
import { Navigation, Pagination } from "swiper/modules";
import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";

interface Toc {
  id: string;
  title: string;
  isActive: boolean;
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

interface DocViewerProps {
  filename: string;
}

export const DocViewerPage = ({filename}: DocViewerProps) => {
  const [mdText, setMdText] = useState("");
  const [toc, setToc] = useState<Toc[]>([]);

  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    const loadMarkdown = async () => {
      try {
        const response = await fetch(`/md/${filename}.md`);
        const text = await response.text();

        setMdText(text);

        const extractedToc = extractToc(text);
        setToc(extractedToc);

        if (extractedToc.length > 0) {
          setActiveId(extractedToc[0].id);
        }
      } catch (e) {
        console.error("Ошибка загрузки:", e);
      }
    };

    loadMarkdown();
  }, [filename]);

  
  useEffect(() => {
    if (!mdText || toc.length === 0) return;

    const handleScroll = () => {
      const headings = Array.from(document.querySelectorAll(`.${styles.markdownWrapper} h2[id]`));
      const offset = 120; 

      const passedHeadings = headings.filter(
        (heading) => heading.getBoundingClientRect().top <= offset
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
  }, [mdText, toc]);


  const markdownComponents = useMemo(() => {
    return {
      h2(props: any) {
        const { node, children, ...rest } = props;
        const headingText = extractTextFromChildren(children);
        const id = generateSlug(headingText);
        
        return <h2 id={id} {...rest}>{children}</h2>;
      },
      code(props: any) {
        const { children, className, node, ...rest } = props;
        const match = /language-(\w+)/.exec(className || "");
        
        if (match && match[1] === "gallery") {
          const content = String(children).replace(/\n$/, "");
          
          const lines = content.split('\n');
          
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
                  const [src, caption] = line.split('|');
                  return (
                    <SwiperSlide key={index}>
                      <figure className={styles.carouselFigure}>
                        <img src={src.trim()} alt={caption?.trim() || "Слайд"} />
                        {caption && <figcaption>{caption.trim()}</figcaption>}
                      </figure>
                    </SwiperSlide>
                  );
                })}
              </Swiper>
            </div>
          );
        }

        return <code className={className} {...rest}>{children}</code>;
      }
    };
  }, []);
  
  return (
    <div className={styles.container}>
      <aside className={styles.sidebar}>
        <ul className={styles.navLinks}>
          {toc.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                // 3. ИЗМЕНЕНО: Сравниваем ID элемента с текущим activeId
                className={`${styles.navLink} ${item.id === activeId ? styles.active : ""}`}
              >
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      </aside>

{/* <div style={{
  position: 'fixed',
  top: '80px', // Должно совпадать с первым значением rootMargin
  bottom: '80%', // Должно совпадать с третьим значением rootMargin (но инвертировано для CSS)
  left: 0,
  right: 0,
  backgroundColor: 'rgba(255, 0, 0, 0.1)', // Прозрачный красный
  borderTop: '2px dashed red',
  borderBottom: '2px dashed red',
  pointerEvents: 'none', // Чтобы слой не мешал кликать по ссылкам
  zIndex: 9999
}}>
  <span style={{ color: 'red', background: 'white', fontSize: '12px' }}>Зона Observer</span>
</div> */}

      <article className={styles.mainContent}>
        <div className={styles.markdownWrapper}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={markdownComponents}
          >
            {mdText}
          </ReactMarkdown>
        </div>
      </article>
    </div>
  );
};
