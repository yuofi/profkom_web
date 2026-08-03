import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { FormikProvider } from "formik";
import clsx from "clsx";
import { guidesApi } from "../../../utils/api/guides.api";
import { blocksApi } from "../../../utils/api/blocks.api";
import styles from "./BlocksManagement.module.css";
import { Button } from "../../../components/Button/Button";
import { Icon } from "../../../components/Icon";
import { FormTextField } from "../../../components/Form/FormTextFiled";
import { FormAutocompleteField } from "../../../components/Form/FormAutocompleteField";
import { useForm } from "../../../components/Form/Form";
import { getDocEditRoute } from "../../../utils/routes";
import { useMe } from "../../../utils/me";
import { canEditGuide } from "../../../utils/filterRoles";
import type { GuideOut } from "../../../utils/api/types";

type SortType = "default" | "alphabetical" | "block";

export const GuidesManagement = () => {
  const me = useMe();
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

  // Find the block where current user is a master
  const userMasterBlock = useMemo(() => {
    if (!blocks || !me) return null;
    return blocks.find(b => b.master === me.kkr_name)?.name || null;
  }, [blocks, me]);

  // Options for selecting owner block in modal
  const blockOptions = useMemo(() => {
    const list = [{ label: "Глобальный (без блока)", value: "none" }];
    if (blocks) {
      blocks.forEach(b => {
        list.push({ label: b.name, value: b.name });
      });
    }
    return list;
  }, [blocks]);

  // Check if current user has permission to edit/delete a given guide
  const canManageGuide = (guide: GuideOut) => {
    return canEditGuide(guide, me, blocks);

};

  const createMutation = useMutation({
    mutationFn: (data: { title: string; owner_block?: string; text?: string }) =>
      guidesApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["guides"] });
      closeModal();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<GuideOut> }) =>
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
      owner_block: z.string().optional(),
    });
  }, []);

  const { formik, isSuccess, globalError } = useForm({
    initialValues: {
      title: "",
      owner_block: me?.super_user ? "none" : (userMasterBlock || ""),
    },
    validationSchema: GuideValidationSchema,
    onSubmit: async (values) => {
      if (editingGuide) {
        await updateMutation.mutateAsync({
          id: editingGuide.guide_id,
          data: {
            title: values.title,
            owner_block: me?.super_user ? (values.owner_block || "none") : (userMasterBlock || editingGuide.owner_block),
            text: editingGuide.text,
            original_link: editingGuide.original_link,
          },
        });
      } else {
        await createMutation.mutateAsync({
          title: values.title,
          owner_block: me?.super_user ? (values.owner_block || "none") : (userMasterBlock || undefined),
          text: `# ${values.title}\n\n`,
        });
      }
    },
  });

  useEffect(() => {
    if (isModalOpen) {
      if (editingGuide) {
        formik.setValues({
          title: editingGuide.title,
          owner_block: editingGuide.owner_block || "none",
        });
      } else {
        formik.resetForm();
        formik.setValues({
          title: "",
          owner_block: me?.super_user ? "none" : (userMasterBlock || ""),
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, editingGuide, me, userMasterBlock]);

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

  if (isGuidesLoading) return <div>Загрузка гайдов...</div>;

  return (
    <>
      <section className={styles.filtersSection}>
        <div className={styles.filtersFlex}>
          <div className={styles.filtersLeft}>
            <div className={styles.filtersHeader}>
              <h2 className={styles.filtersTitle}>Фильтры</h2>
              <button
                className={styles.clearFilters}
                onClick={() => {
                  setSortType("default");
                  setBlockFilter(null);
                  setSearchQuery("");
                }}
              >
                очистить
              </button>
            </div>

            <div className={styles.filtersChipsContainer}>
              <input
                type="text"
                className={styles.searchInput}
                placeholder="Поиск по названию..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />

              <select
                className={styles.filterSelect}
                value={sortType}
                onChange={(e) => setSortType(e.target.value as SortType)}
              >
                <option value="default">Сортировка: по умолчанию</option>
                <option value="alphabetical">Сортировка: по алфавиту</option>
                <option value="block">Сортировка: по блоку</option>
              </select>

              <select
                className={styles.filterSelect}
                value={blockFilter || ""}
                onChange={(e) => setBlockFilter(e.target.value || null)}
              >
                <option value="">Все блоки</option>
                <option value="none">Глобальные (без блока)</option>
                {uniqueBlocksInGuides.map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.filtersRight}>
            {(me?.super_user || userMasterBlock || me?.admin) && (
              <button className={styles.createBlockBtn} onClick={openCreateModal}>
                <Icon name="add" size={20} />
                Создать гайд
              </button>
            )}
          </div>
        </div>
      </section>

      <section className={styles.tableContainer}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Название гайда</th>
                <th>Блок</th>
                <th>Текст статьи</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {processedGuides.length === 0 && (
                <tr>
                  <td colSpan={4} className={styles.tdCenter}>
                    Гайды не найдены
                  </td>
                </tr>
              )}
              {processedGuides.map((guide) => {
                const isSuper = !guide.owner_block || guide.owner_block.toLowerCase() === "none" || guide.owner_block.toLowerCase() === "all";
                const hasManageRights = canManageGuide(guide);

                return (
                  <tr key={guide.guide_id}>
                    <td className={styles.tdPrimary}>{guide.title}</td>
                    <td>
                      <span className={styles.chip}>
                        {isSuper ? "Глобальный" : guide.owner_block}
                      </span>
                    </td>
                    <td>
                      <button
                        className={styles.docEditBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(getDocEditRoute(guide.guide_id));
                        }}
                        title="Перейти к редактированию статьи"
                      >
                        <Icon name="edit_document" size={16} />
                        Редактировать статью
                      </button>
                    </td>
                    <td>
                      <div className={styles.actionsContainer}>
                        {hasManageRights && (
                          <button
                            className={clsx(styles.actionBtn, styles.actionBtnEdit)}
                            onClick={(e) => openEditModal(e, guide)}
                            title="Изменить настройки гайда"
                          >
                            <Icon name="edit" size={20} />
                          </button>
                        )}
                        {hasManageRights && (
                          <button
                            className={clsx(styles.actionBtn, styles.actionBtnDelete)}
                            onClick={(e) => handleDelete(e, guide)}
                            title="Удалить гайд"
                          >
                            <Icon name="delete" size={20} />
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
      </section>

      {isModalOpen && (
        <div className={styles.modalOverlay} onClick={closeModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>{editingGuide ? "Редактировать гайд" : "Создать новый гайд"}</h3>
            </div>

            <FormikProvider value={formik}>
              <form className={styles.modalForm} onSubmit={formik.handleSubmit}>
                <FormTextField
                  name="title"
                  label="Название гайда"
                  color="secondary"
                />

                {me?.super_user ? (
                  <FormAutocompleteField
                    name="owner_block"
                    label="Блок гайда"
                    options={blockOptions}
                  />
                ) : (
                  <FormTextField
                    name="owner_block"
                    label="Блок (назначается автоматически)"
                    value={userMasterBlock || "Ваш блок"}
                    disabled
                    color="secondary"
                  />
                )}

                {globalError && (
                  <div className={styles.errorText}>
                    {globalError}
                  </div>
                )}

                {isSuccess && <div className={styles.successText}>Успешно сохранено!</div>}

                <div className={styles.modalActions}>
                  <Button variant="tertiary" onClick={closeModal}>
                    Отмена
                  </Button>
                  <Button
                    variant="tertiary"
                    type="submit"
                    disabled={formik.isSubmitting}
                  >
                    {editingGuide ? "Сохранить" : "Создать"}
                  </Button>
                </div>
              </form>
            </FormikProvider>
          </div>
        </div>
      )}
    </>
  );
};