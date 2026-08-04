import { useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button/Button";
import { CardLabel } from "../../components/CardLabel/CardLabel";
import { guidesApi } from "../../utils/api/guides.api";
import { useMe } from "../../utils/me";
import styles from "./DocEditPage.module.css";
import { GalleryExtension } from "../../components/Gallery/GalleryExtension";
import { ContactChipExtension } from "../../components/ContactChip/ContactChipExtension";
import { Helmet } from "react-helmet-async";
import type { GuideOut } from "../../utils/api/types";

interface DocEditorProps {
  guide: GuideOut;
  id: string;
}

const DocEditor = ({ guide, id }: DocEditorProps) => {
  const navigate = useNavigate();
  const [isSaving, setIsSaving] = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2] },
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: "noopener noreferrer", target: null },
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
    content: guide.text || "",
    editorProps: {
      attributes: { class: styles.tiptapEditor },
    },
  });

  const handleSave = useCallback(async () => {
    if (!editor || !guide || !id) return;

    setIsSaving(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const storage = (editor.storage as any).markdown as MarkdownStorage;
    const markdownOutput = storage.getMarkdown();

    try {
      const doc = {
        title: guide.title,
        text: markdownOutput,
        owner_block: guide.owner_block,
      };
      await guidesApi.update(id, doc);
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
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("URL", previousUrl);

    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  return (
    <div className={styles.container}>
      <Helmet>
        <title>
          {guide
            ? `Редактирование: ${guide.title} | Профком ВМК`
            : "Редактирование | Профком ВМК"}
        </title>
      </Helmet>
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
                className={`${styles.toolbarBtn} ${editor?.isActive("bold") ? styles.active : ""}`}
                title="Жирный"
              >
                <Icon name="format_bold" size={20} />
              </Button>
              <Button
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive("italic") ? styles.active : ""}`}
                title="Курсив"
              >
                <Icon name="format_italic" size={20} />
              </Button>
              <Button
                variant="transparent"
                onClick={setLink}
                className={`${styles.toolbarBtn} ${editor?.isActive("link") ? styles.active : ""}`}
                title="Ссылка"
              >
                <Icon name="link" size={20} />
              </Button>
            </div>

            <div className={styles.toolbarSection}>
              <Button
                variant="transparent"
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 2 }).run()
                }
                className={`${styles.toolbarBtn} ${editor?.isActive("heading", { level: 2 }) ? styles.active : ""}`}
                title="Заголовок H2"
              >
                <Icon name="format_h2" size={20} />
              </Button>
            </div>

            <div className={styles.toolbarSection}>
              <Button
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive("bulletList") ? styles.active : ""}`}
                title="Список"
              >
                <Icon name="format_list_bulleted" size={20} />
              </Button>
              <Button
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive("blockquote") ? styles.active : ""}`}
                title="Цитата"
              >
                <Icon name="format_quote" size={20} />
              </Button>
            </div>

            <div className={styles.toolbarSection}>
              <Button
                variant="transparent"
                onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
                className={`${styles.toolbarBtn} ${editor?.isActive("codeBlock") ? styles.active : ""}`}
                title="Блок кода"
              >
                <Icon name="code_blocks" size={20} />
              </Button>
              <Button
                variant="transparent"
                onClick={() =>
                  editor
                    ?.chain()
                    .focus()
                    .insertContent({ type: "gallery", attrs: { content: "" } })
                    .run()
                }
                className={`${styles.toolbarBtn} ${editor?.isActive("gallery") ? styles.active : ""}`}
                title="Галерея"
              >
                <Icon name="add_photo_alternate" size={20} />
              </Button>
              <Button
                variant="transparent"
                onClick={() =>
                  editor
                    ?.chain()
                    .focus()
                    .insertContent({
                      type: "contactChip",
                      attrs: { content: "" },
                    })
                    .run()
                }
                className={`${styles.toolbarBtn} ${editor?.isActive("contactChip") ? styles.active : ""}`}
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
        <Button
          variant="primary"
          onClick={() => navigate(-1)}
          className={styles.saveFab}
          title="Назад"
        >
          <Icon name="arrow_left_alt" size={24} />
        </Button>

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

export const DocEditPage = () => {
  const user = useMe();
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

  if (isLoading)
    return <div className={styles.container}>Загрузка редактора...</div>;
  if (isError) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (error as any)?.response?.status;
    if (status === 403) {
      return (
        <div className={styles.container}>
          Доступ к редактированию данного документа ограничен.
        </div>
      );
    }
    return <div className={styles.container}>Ошибка при загрузке данных.</div>;
  }
  if (!guide || !id)
    return <div className={styles.container}>Документ не найден.</div>;

  return <DocEditor key={id} guide={guide} id={id} />;
};

export default DocEditPage;
