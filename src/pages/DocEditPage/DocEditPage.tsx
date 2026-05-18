import { useState, useEffect, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { Icon } from "../../components/Icon";
import styles from "./DocEditPage.module.css";

interface DocEditorProps {
  filename: string;
}

export const DocEditPage = ({ filename }: DocEditorProps) => {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [2],
        },
        // Отключаем стандартный HardBreak, чтобы настроить его поведение если нужно, 
        // но здесь нам важнее как Markdown парсит строки
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: null,
        },
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        tightListClass: "tight",
        breaks: true, // Это включает поведение аналогичное remark-breaks
      }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: styles.tiptapEditor,
      },
    },
  });

  useEffect(() => {
    const loadMarkdown = async () => {
      try {
        const response = await fetch(`/md/${filename}.md`);
        if (!response.ok) throw new Error("Failed to load");
        const text = await response.text();
        
        if (editor) {
          editor.commands.setContent(text);
        }
      } catch (e) {
        console.error("Ошибка загрузки:", e);
      } finally {
        setIsLoading(false);
      }
    };

    if (editor && isLoading) {
      loadMarkdown();
    }
  }, [filename, editor, isLoading]);

  const handleSave = useCallback(async () => {
    if (!editor) return;

    setIsSaving(true);
    const storage = editor.storage.markdown as MarkdownStorage;
    const markdownOutput = storage.getMarkdown();
    
    try {
      console.log("Saving markdown for", filename, ":", markdownOutput);
      await new Promise(resolve => setTimeout(resolve, 1000));
      alert("Документ успешно сохранен! (имитация)");
    } catch (error) {
      console.error("Ошибка сохранения:", error);
      alert("Ошибка при сохранении");
    } finally {
      setIsSaving(false);
    }
  }, [editor, filename]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href;
    const url = window.prompt('URL', previousUrl);

    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  if (isLoading) return <div className={styles.container}>Загрузка редактора...</div>;

  return (
    <div className={styles.container}>
      <article className={styles.mainContent}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarSection}>
            <button 
              onClick={() => editor?.chain().focus().toggleBold().run()}
              className={`${styles.toolbarBtn} ${editor?.isActive('bold') ? styles.active : ""}`}
              title="Жирный"
            >
              <Icon name="format_bold" size={20} />
            </button>
            <button 
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              className={`${styles.toolbarBtn} ${editor?.isActive('italic') ? styles.active : ""}`}
              title="Курсив"
            >
              <Icon name="format_italic" size={20} />
            </button>
            <button 
              onClick={setLink}
              className={`${styles.toolbarBtn} ${editor?.isActive('link') ? styles.active : ""}`}
              title="Ссылка"
            >
              <Icon name="link" size={20} />
            </button>
          </div>

          <div className={styles.toolbarSection}>
            <button 
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`${styles.toolbarBtn} ${editor?.isActive('heading', { level: 2 }) ? styles.active : ""}`}
              title="Заголовок H2"
            >
              <Icon name="format_h2" size={20} />
            </button>
          </div>

          <div className={styles.toolbarSection}>
            <button 
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              className={`${styles.toolbarBtn} ${editor?.isActive('bulletList') ? styles.active : ""}`}
              title="Список"
            >
              <Icon name="format_list_bulleted" size={20} />
            </button>
            <button 
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              className={`${styles.toolbarBtn} ${editor?.isActive('blockquote') ? styles.active : ""}`}
              title="Цитата"
            >
              <Icon name="format_quote" size={20} />
            </button>
          </div>

          <div className={styles.toolbarSection}>
            <button 
              onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
              className={`${styles.toolbarBtn} ${editor?.isActive('codeBlock') ? styles.active : ""}`}
              title="Блок кода / Галерея"
            >
              <Icon name="code_blocks" size={20} />
            </button>
          </div>

          <button onClick={handleSave} className={styles.saveBtn} disabled={isSaving}>
            {isSaving ? "Сохранение..." : "Сохранить"}
          </button>
        </div>

        <div className={styles.statusInfoTop}>
          Редактирование: <strong>{filename}.md</strong>
        </div>

        <div className={styles.editorWrapper}>
          <EditorContent editor={editor} />
        </div>
      </article>
    </div>
  );
};
