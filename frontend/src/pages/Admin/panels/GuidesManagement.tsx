import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { FormikProvider } from "formik";
import { useGuardedAction } from "../../../components/Workspace/unsavedChangesHooks";
import { guidesApi } from "../../../utils/api/guides.api";
import { blocksApi } from "../../../utils/api/blocks.api";
import styles from "./BlocksManagement.module.css";
import { FormTextField } from "../../../components/Form/FormTextFiled";
import { FormAutocompleteField } from "../../../components/Form/FormAutocompleteField";
import { useForm } from "../../../components/Form/Form";
import { getDocEditRoute, getDocRoute } from "../../../utils/routes";
import { useMe } from "../../../utils/me";
import { canEditGuide } from "../../../utils/filterRoles";
import type { GuideOut } from "../../../utils/api/types";
import { LegacyGuideNotice } from "../../../components/Workspace/LegacyGuideNotice";
import { Badge, Glyph, Loading } from "../../../components/Workspace/WorkspaceUI";
import s from "../../../components/Workspace/Workspace.module.css";

type SortType = "default" | "alphabetical" | "block";

export const GuidesManagement = () => {
  const me = useMe();
  const scope = useId();
  const requestClose = useGuardedAction(scope);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingGuide, setEditingGuide] = useState<GuideOut | null>(null);
  const [blockFilter, setBlockFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortType, setSortType] = useState<SortType>("default");

  const { data: guides, isLoading: isGuidesLoading } = useQuery({
    queryKey: ["guides", me?.user_id ?? "anon"],
    queryFn: guidesApi.getAll,
  });

  const { data: blocks } = useQuery({
    queryKey: ["blocks"],
    queryFn: blocksApi.getAll,
  });

  // Find the blocks where current user is a master
  const userMasterBlocks = useMemo(() => {
    if (!blocks || !me) return [];
    return blocks.filter(b => b.master?.user.user_id === me.user_id || b.master?.deputy_user_ids.includes(me.user_id)).map(b => b.name);
  }, [blocks, me]);

  const userMasterBlock = userMasterBlocks[0] || null;
  const canCreateGuide = !!me?.super_user || userMasterBlocks.length > 0;

  // Options for selecting owner block in modal for superusers
  const superUserBlockOptions = useMemo(() => {
    const list = [{ label: "Глобальный (для всех)", value: "none" }];
    if (blocks) {
      blocks.forEach(b => {
        list.push({ label: b.name, value: b.name });
      });
    }
    return list;
  }, [blocks]);

  // Options for selecting owner block in modal for masters (can toggle between global and their block)
  const masterBlockOptions = useMemo(() => {
    const list = [{ label: "Глобальный (для всех)", value: "none" }];
    userMasterBlocks.forEach(bName => {
      list.push({ label: `Только для блока ${bName}`, value: bName });
    });
    return list;
  }, [userMasterBlocks]);

  // Check if current user has permission to edit/delete a given guide
  const canManageGuide = (guide: GuideOut) => {
    return canEditGuide(guide, me, blocks);
  };

  const createMutation = useMutation({
    mutationFn: (data: { title: string; owner_block?: string; text?: string; description?: string }) =>
      guidesApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guides"] });
      closeModal();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<GuideOut> & { expected_revision?: number } }) =>
      guidesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guides"] });
      closeModal();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (guideId: number) => guidesApi.delete(guideId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guides"] });
    },
  });

  const GuideValidationSchema = useMemo(() => {
    return z.object({
      title: z.string().min(1, "Название обязательно"),
      description: z.string().optional(),
      owner_block: z.string().optional(),
    });
  }, []);

  const { formik, isSuccess, globalError } = useForm({
    initialValues: {
      title: "",
      description: "",
      owner_block: me?.super_user ? "none" : (userMasterBlock || "none"),
    },
    validationSchema: GuideValidationSchema,
    protectChanges: { enabled: isModalOpen, scope, label: "Сведения о гайде", externalBusy: createMutation.isPending || updateMutation.isPending },
    onSubmit: async (values) => {
      const selectedOwnerBlock = values.owner_block || "none";
      if (editingGuide) {
        await updateMutation.mutateAsync({
          id: editingGuide.guide_id,
          data: {
            expected_revision: editingGuide.revision,
            title: values.title,
            description: values.description || "",
            owner_block: selectedOwnerBlock,
            // No text: the loaded one carries signed links and would overwrite the source (A-MAT-1).
            original_link: editingGuide.original_link,
          },
        });
      } else {
        await createMutation.mutateAsync({
          title: values.title,
          description: values.description || "",
          owner_block: me?.super_user ? selectedOwnerBlock : (userMasterBlock || selectedOwnerBlock),
          text: `# ${values.title}\n\n`,
        });
      }
    },
  });

  useEffect(() => {
    if (isModalOpen) {
      if (editingGuide) {
        formik.resetForm({ values: {
          title: editingGuide.title,
          description: editingGuide.description || "",
          owner_block: editingGuide.owner_block || "none",
        } });
      } else {
        formik.resetForm({ values: {
          title: "",
          description: "",
          owner_block: me?.super_user ? "none" : (userMasterBlock || "none"),
        } });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, editingGuide]);

  const openCreateModal = () => {
    setEditingGuide(null);
    setIsModalOpen(true);
  };

  const openEditModal = (e: React.MouseEvent, guide: GuideOut) => {
    e.stopPropagation();
    setEditingGuide(guide);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingGuide(null);
    formik.resetForm();
  };

  const handleDelete = async (e: React.MouseEvent, guide: GuideOut) => {
    e.stopPropagation();
    if (confirm(`Вы уверены, что хотите удалить гайд "${guide.title}"?`)) {
      deleteMutation.mutate(guide.guide_id);
    }
  };

  const processedGuides = useMemo(() => {
    if (!guides) return [];

    let result = [...guides];

    if (blockFilter) {
      if (blockFilter === "none") {
        result = result.filter(
          g => !g.owner_block || g.owner_block.toLowerCase() === "none" || g.owner_block.toLowerCase() === "all"
        );
      } else {
        result = result.filter(
          g => g.owner_block && g.owner_block.toLowerCase() === blockFilter.toLowerCase()
        );
      }
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(g => g.title.toLowerCase().includes(q));
    }

    if (sortType === "alphabetical") {
      result.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortType === "block") {
      result.sort((a, b) => (a.owner_block || "").localeCompare(b.owner_block || ""));
    }

    return result;
  }, [guides, blockFilter, searchQuery, sortType]);

  const uniqueBlocksInGuides = useMemo(() => {
    if (!guides) return [];
    const set = new Set<string>();
    guides.forEach(g => {
      if (g.owner_block && g.owner_block.toLowerCase() !== "none" && g.owner_block.toLowerCase() !== "all") {
        set.add(g.owner_block);
      }
    });
    return Array.from(set).sort();
  }, [guides]);

  if (isGuidesLoading) return <Loading />;

  return (
    <>
      <LegacyGuideNotice />
      <div className={s.filters}>
        <label className={`${s.field} ${s.search}`}>
          Поиск
          <input
            type="search"
            placeholder="Название гайда"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
        <label className={s.field}>
          Порядок
          <select
            value={sortType}
            onChange={(e) => setSortType(e.target.value as SortType)}
          >
            <option value="default">По умолчанию</option>
            <option value="alphabetical">По алфавиту</option>
            <option value="block">По блоку</option>
          </select>
        </label>
        <label className={s.field}>
          Блок
          <select
            value={blockFilter || ""}
            onChange={(e) => setBlockFilter(e.target.value || null)}
          >
            <option value="">Все блоки</option>
            <option value="none">Глобальные (для всех)</option>
            {uniqueBlocksInGuides.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        <div className={s.row}>
          <button
            className={s.button}
            onClick={() => {
              setSortType("default");
              setBlockFilter(null);
              setSearchQuery("");
            }}
          >
            Сбросить
          </button>
          {canCreateGuide && (
            <button className={`${s.button} ${s.primary}`} onClick={openCreateModal}>
              <Glyph name="add" />
              Создать гайд
            </button>
          )}
        </div>
      </div>

      <div className={`${s.tableWrap} ${s.guidesTable}`}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Название гайда</th>
              <th>Видимость</th>
              <th>Текст статьи</th>
              <th aria-label="Действия"></th>
            </tr>
          </thead>
          <tbody>
            {processedGuides.length === 0 && (
              <tr>
                <td colSpan={4} className={s.muted}>
                  Гайды не найдены
                </td>
              </tr>
            )}
            {processedGuides.map((guide) => {
              const isSuper = !guide.owner_block || guide.owner_block.toLowerCase() === "none" || guide.owner_block.toLowerCase() === "all";
              const hasManageRights = canManageGuide(guide);

              return (
                <tr key={guide.guide_id}>
                  <td>{guide.title}</td>
                  <td>
                    <Badge tone={isSuper ? "sky" : "peach"}>
                      {isSuper ? "Глобальный (для всех)" : guide.owner_block}
                    </Badge>
                  </td>
                  <td>
                    {hasManageRights ? (
                      <button
                        className={`${s.button} ${styles.compact}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(getDocEditRoute(guide.guide_id));
                        }}
                        title="Перейти к редактированию статьи"
                      >
                        <Glyph name="edit_document" />
                        Редактировать статью
                      </button>
                    ) : (
                      <button
                        className={`${s.button} ${styles.compact}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(getDocRoute(guide.guide_id));
                        }}
                        title="Просмотр статьи"
                      >
                        <Glyph name="visibility" />
                        Просмотр статьи
                      </button>
                    )}
                  </td>
                  <td>
                    <div className={styles.iconActions}>
                      {hasManageRights && (
                        <button
                          className={`${s.button} ${styles.compact}`}
                          onClick={(e) => openEditModal(e, guide)}
                          title="Изменить настройки гайда"
                          aria-label={`Изменить настройки гайда «${guide.title}»`}
                        >
                          <Glyph name="edit" />
                        </button>
                      )}
                      {hasManageRights && (
                        <button
                          className={`${s.button} ${s.danger} ${styles.compact}`}
                          onClick={(e) => handleDelete(e, guide)}
                          title="Удалить гайд"
                          aria-label={`Удалить гайд «${guide.title}»`}
                        >
                          <Glyph name="delete" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={s.guideCards}>
        {processedGuides.length === 0 && <p className={s.muted}>Гайды не найдены</p>}
        {processedGuides.map((guide) => {
          const isSuper = !guide.owner_block || guide.owner_block.toLowerCase() === "none" || guide.owner_block.toLowerCase() === "all";
          const hasManageRights = canManageGuide(guide);
          return (
            <article className={`${s.card} ${s.guideCard}`} key={guide.guide_id}>
              <div className={s.between}>
                <h2>{guide.title}</h2>
                <Badge tone={isSuper ? "sky" : "peach"}>
                  {isSuper ? "Глобальный (для всех)" : guide.owner_block}
                </Badge>
              </div>
              <div className={s.guideCardActions}>
                <button
                  className={s.button}
                  onClick={() => navigate(hasManageRights ? getDocEditRoute(guide.guide_id) : getDocRoute(guide.guide_id))}
                >
                  <Glyph name={hasManageRights ? "edit_document" : "visibility"} />
                  {hasManageRights ? "Редактировать статью" : "Просмотр статьи"}
                </button>
                {hasManageRights && (
                  <button
                    className={`${s.button} ${s.guideIconAction}`}
                    onClick={(e) => openEditModal(e, guide)}
                    title="Изменить настройки гайда"
                    aria-label={`Изменить настройки гайда «${guide.title}»`}
                  >
                    <Glyph name="edit" />
                  </button>
                )}
                {hasManageRights && (
                  <button
                    className={`${s.button} ${s.danger} ${s.guideIconAction}`}
                    onClick={(e) => handleDelete(e, guide)}
                    title="Удалить гайд"
                    aria-label={`Удалить гайд «${guide.title}»`}
                  >
                    <Glyph name="delete" />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {isModalOpen && (
        <div className={styles.modalOverlay} onClick={() => requestClose(closeModal)}>
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h3 id="guide-settings-title">{editingGuide ? "Редактировать гайд" : "Создать новый гайд"}</h3>
            </div>

            <FormikProvider value={formik}>
              <form className={styles.modalForm} onSubmit={formik.handleSubmit}>
                <FormTextField
                  name="title"
                  label="Название гайда"
                  color="secondary"
                />

                <FormTextField
                  name="description"
                  label="Краткое описание"
                  color="secondary"
                />

                <FormAutocompleteField
                  name="owner_block"
                  label="Видимость / Блок гайда"
                  options={me?.super_user ? superUserBlockOptions : masterBlockOptions}
                />

                {globalError && (
                  <p role="alert" className={s.fieldError}>
                    {globalError}
                  </p>
                )}

                {isSuccess && <p role="status" className={s.success}>Успешно сохранено!</p>}

                <div className={styles.modalActions}>
                  <button type="button" className={s.button} onClick={() => requestClose(closeModal)}>
                    Отмена
                  </button>
                  <button
                    className={`${s.button} ${s.primary}`}
                    type="submit"
                    disabled={formik.isSubmitting}
                  >
                    {editingGuide ? "Сохранить" : "Создать"}
                  </button>
                </div>
              </form>
            </FormikProvider>
          </div>
        </div>
      )}
    </>
  );
};
