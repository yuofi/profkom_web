import { useState, useEffect, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {Link as RouterLink} from "react-router-dom";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button/Button";
import { CardLabel } from "../../components/CardLabel/CardLabel";
import { api } from "../../utils/api";
import type { GuideOut } from "../../utils/api/types";
import styles from "./DocEditPage.module.css";
import { getDocRoute } from "../../utils/routes";
import { GalleryExtension } from "../../components/Gallery/GalleryExtension";
import { ContactChipExtension } from "../../components/ContactChip/ContactChipExtension";

export const DocEditPage = () => {
  const [isSaving, setIsSaving] = useState(false);
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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: null },
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        tightListClass: "tight",
        breaks: true,
      }),
      GalleryExtension,
      ContactChipExtension,
    ],
    content: "",
    editorProps: {
      attributes: { class: styles.tiptapEditor },
    },
  });

  useEffect(() => {
    if (guide && editor && !editor.getText()) {
      editor.commands.setContent(guide.text);
    }
  }, [guide, editor]);

  const handleSave = useCallback(async () => {
    if (!editor || !guide) return;

    setIsSaving(true);
    const storage = editor.storage.markdown as MarkdownStorage;
    const markdownOutput = storage.getMarkdown();
    
    try {
      const doc = {
        title: guide.title,
        text: markdownOutput,
        owner_block: guide.owner_block
      };
      await api.post<GuideOut>(`/guides/${id}`, doc);
      alert("Документ успешно сохранен!");
    } catch (error) {
      console.error("Ошибка сохранения:", error);
      alert("Ошибка при сохранении");
    } finally {
      setIsSaving(false);
    }
  }, [editor, guide, id]);

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
  if (isError) return <div className={styles.container}>Ошибка при загрузке данных.</div>;
  if (!guide) return <div className={styles.container}>Документ не найден.</div>;

  return (
    <div className={styles.container}>
      <article className={styles.mainContent}>
        <div className={styles.statusInfoTop}>
          <CardLabel variant="black" iconName="edit_note">
            Редактирование: <strong>{guide.title}</strong>
          </CardLabel>
        </div>

        <div className={styles.editorLayout}>
          <div className={styles.toolbar}>
            <div className={styles.toolbarSection}>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleBold().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('bold') ? styles.active : ""}`}
                title="Жирный"
              >
                <Icon name="format_bold" size={20} />
              </Button>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('italic') ? styles.active : ""}`}
                title="Курсив"
              >
                <Icon name="format_italic" size={20} />
              </Button>
              <Button 
                variant="transparent"
                onClick={setLink}
                className={`${styles.toolbarBtn} ${editor?.isActive('link') ? styles.active : ""}`}
                title="Ссылка"
              >
                <Icon name="link" size={20} />
              </Button>
            </div>

            <div className={styles.toolbarSection}>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('heading', { level: 2 }) ? styles.active : ""}`}
                title="Заголовок H2"
              >
                <Icon name="format_h2" size={20} />
              </Button>
            </div>

            <div className={styles.toolbarSection}>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('bulletList') ? styles.active : ""}`}
                title="Список"
              >
                <Icon name="format_list_bulleted" size={20} />
              </Button>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('blockquote') ? styles.active : ""}`}
                title="Цитата"
              >
                <Icon name="format_quote" size={20} />
              </Button>
            </div>

            <div className={styles.toolbarSection}>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('codeBlock') ? styles.active : ""}`}
                title="Блок кода"
              >
                <Icon name="code_blocks" size={20} />
              </Button>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().insertContent({ type: 'gallery', attrs: { content: '' } }).run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('gallery') ? styles.active : ""}`}
                title="Галерея"
              >
                <Icon name="add_photo_alternate" size={20} />
              </Button>
              <Button 
                variant="transparent"
                onClick={() => editor?.chain().focus().insertContent({ type: 'contactChip', attrs: { content: '' } }).run()}
                className={`${styles.toolbarBtn} ${editor?.isActive('contactChip') ? styles.active : ""}`}
                title="Добавить контакт"
              >
                <Icon name="person_add" size={20} />
              </Button>
            </div>
          </div>

          <div className={styles.editorWrapper}>
            <EditorContent editor={editor} />
          </div>
        </div>
      </article>

      <div className={styles.statusInfoBottom}>
      
       <RouterLink 
        to={getDocRoute(guide.guide_id)} 
        className={styles.saveFab}
        title="Назад"
      >
        <Icon name="arrow_left_alt" size={24} />
      </RouterLink>
      
      <Button 
        variant="primary"
        onClick={handleSave} 
        className={styles.saveFab} 
        disabled={isSaving}
        title="Сохранить"
      >
        {isSaving ? (
          <div className={styles.loader} />
        ) : (
          <Icon name="save" size={24} />
        )}
      </Button>
      
      </div>
      
    </div>
  );
};
