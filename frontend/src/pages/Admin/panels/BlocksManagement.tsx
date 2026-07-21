import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo } from "react";
import { z } from "zod";
import { FormikProvider, useFormik } from "formik";
import { blocksApi } from "../../../utils/api/blocks.api";
import { contactsApi } from "../../../utils/api/contacts.api";
import styles from "./BlocksManagement.module.css";
import { Button } from "../../../components/Button/Button";
import { Icon } from "../../../components/Icon";
import { FormTextField } from "../../../components/Form/FormTextFiled";
import { FormAutocompleteField } from "../../../components/Form/FormAutocompleteField";
import { useForm } from "../../../components/Form/Form";
import type { BlockOut } from "../../../utils/api/types";
import clsx from "clsx";

// type BlockFormValues = {
//   name: string;
//   master: string;
//   hr?: string;
// };

export const BlocksManagement = () => {
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<BlockOut | null>(null);
  const [selectedBlockName, setSelectedBlockName] = useState<string | null>(null);

  type SortType = "default" | "peopleCount" | "alphabetical";
  const [sortType, setSortType] = useState<SortType>("default");
  const [hrFilter, setHrFilter] = useState<string | null>(null);

  const { data: blocks, isLoading: isBlocksLoading } = useQuery({
    queryKey: ["blocks"],
    queryFn: blocksApi.getAll,
  });

  const { data: contacts } = useQuery({
    queryKey: ["contacts"],
    queryFn: contactsApi.getAll,
  });

  const uniqueHRs = useMemo(() => {
    if (!blocks) return [];
    const hrs = blocks.map(b => b.hr).filter(Boolean) as string[];
    return Array.from(new Set(hrs)).sort();
  }, [blocks]);

  const processedBlocks = useMemo(() => {
    if (!blocks) return [];
    
    let result = [...blocks];
    
    if (hrFilter) {
      result = result.filter(b => b.hr === hrFilter);
    }
    
    if (sortType === "peopleCount") {
      result.sort((a, b) => b.arr_of_human.length - a.arr_of_human.length);
    } else if (sortType === "alphabetical") {
      result.sort((a, b) => a.name.localeCompare(b.name));
    }
    
    return result;
  }, [blocks, sortType, hrFilter]);

  const selectedBlock = useMemo(() => 
    blocks?.find(b => b.name === selectedBlockName) || null
  , [blocks, selectedBlockName]);

  const selectedBlockMembers = useMemo(() => {
    if (!selectedBlock || !contacts) return [];
    return contacts.filter(c => selectedBlock.arr_of_human.includes(c.user_id));
  }, [selectedBlock, contacts]);

  const peopleOptions = useMemo(() => {
    if (!contacts) return [];
    return contacts.map(c => ({
      label: `${c.surname} ${c.name} ${c.patronymic}`.trim(),
      value: c.kkr_name
    }));
  }, [contacts]);

  const availablePeopleOptions = useMemo(() => {
    if (!contacts || !selectedBlock) return [];
    return contacts
      .filter(c => !selectedBlock.arr_of_human.includes(c.user_id))
      .map(c => ({
        label: `${c.surname} ${c.name} ${c.patronymic}`.trim(),
        value: c.user_id.toString()
      }));
  }, [contacts, selectedBlock]);

  const BlockValidationSchema = useMemo(() => {
    const validNames = peopleOptions.map(o => o.value);
    return z.object({
      name: z.string().min(1, "Название обязательно"),
      master: z.string()
        .min(1, "Мастер обязателен")
        .refine(val => validNames.includes(val), "Выберите мастера из списка"),
      hr: z.string()
        .optional()
        .refine(val => !val || validNames.includes(val), "Выберите HR из списка"),
    });
  }, [peopleOptions]);

  const createMutation = useMutation({
    mutationFn: blocksApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
      closeModal();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, data }: { name: string; data: Partial<BlockOut> }) =>
      blocksApi.update(name, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
      closeModal();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: blocksApi.delete,
    onSuccess: (_, deletedName) => {
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
      if (selectedBlockName === deletedName) {
        setSelectedBlockName(null);
      }
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: ({ blockName, userId }: { blockName: string; userId: number }) => {
      const currentArr = blocks?.find(b => b.name === blockName)?.arr_of_human || [];
      return blocksApi.update(blockName, { arr_of_human: [...currentArr, userId] });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: ({ blockName, userId }: { blockName: string; userId: number }) => {
      const currentArr = blocks?.find(b => b.name === blockName)?.arr_of_human || [];
      return blocksApi.update(blockName, { arr_of_human: currentArr.filter(id => id !== userId) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blocks"] });
    },
  });

  const { formik, isSuccess, globalError } = useForm({
    initialValues: {
      name: "",
      master: "",
      hr: "",
    },
    validationSchema: BlockValidationSchema,
    onSubmit: async (values) => {
      if (editingBlock) {
        await updateMutation.mutateAsync({ name: editingBlock.name, data: values });
      } else {
        await createMutation.mutateAsync(values);
      }
    },
  });

  const addMemberFormik = useFormik({
    initialValues: {
      userId: "",
    },
    onSubmit: async (values, { resetForm }) => {
      if (selectedBlockName && values.userId) {
        await addMemberMutation.mutateAsync({ 
          blockName: selectedBlockName, 
          userId: parseInt(values.userId) 
        });
        resetForm();
      }
    },
  });

  useEffect(() => {
    if (isModalOpen) {
      if (editingBlock) {
        formik.setValues({
          name: editingBlock.name,
          master: editingBlock.master || "",
          hr: editingBlock.hr || "",
        });
      } else {
        formik.resetForm();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, editingBlock]);

  const openCreateModal = () => {
    setEditingBlock(null);
    setIsModalOpen(true);
  };

  const openEditModal = (e: React.MouseEvent, block: BlockOut) => {
    e.stopPropagation();
    setEditingBlock(block);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingBlock(null);
    formik.resetForm();
  };

  const handleDelete = async (e: React.MouseEvent, name: string) => {
    e.stopPropagation();
    if (confirm(`Вы уверены, что хотите удалить блок "${name}"?`)) {
      deleteMutation.mutate(name);
    }
  };

  if (isBlocksLoading) return <div>Загрузка блоков...</div>;

  return (
    <>
      <section className={styles.filtersSection}>
        <div className={styles.filtersFlex}>
          <div className={styles.filtersLeft}>
            <div className={styles.filtersHeader}>
              <h2 className={styles.filtersTitle}>Фильтры</h2>
              <button 
                className={styles.clearFilters}
                onClick={() => { setSortType("default"); setHrFilter(null); }}
              >
                очистить
              </button>
            </div>
            
            <div className={styles.filtersChipsContainer}>
              <select 
                className={styles.filterSelect}
                value={sortType}
                onChange={(e) => setSortType(e.target.value as SortType)}
              >
                <option value="default">Сортировка: по умолчанию</option>
                <option value="alphabetical">Сортировка: по алфавиту</option>
                <option value="peopleCount">Сортировка: по кол-ву людей</option>
              </select>

              <select
                className={styles.filterSelect}
                value={hrFilter || ""}
                onChange={(e) => setHrFilter(e.target.value || null)}
              >
                <option value="">Все HR</option>
                {uniqueHRs.map(hr => (
                  <option key={hr} value={hr}>{hr}</option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.filtersRight}>
            <button className={styles.createBlockBtn} onClick={openCreateModal}>
              <Icon name="add" size={20} />
              Создать блок
            </button>
          </div>
        </div>
      </section>

      <section className={styles.tableContainer}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Название блока</th>
                <th>Мастер</th>
                <th>HR</th>
                <th className={styles.tdCenter}>Кол-во людей</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {processedBlocks.map((block) => (
                <tr 
                  key={block.name} 
                  onClick={() => setSelectedBlockName(block.name)}
                  className={selectedBlockName === block.name ? styles.selectedRow : ""}
                >
                  <td>
                    <span className={styles.chip}>{block.name}</span>
                  </td>
                  <td className={styles.tdPrimary}>{block.master || "Не назначен"}</td>
                  <td className={styles.tdSecondary}>{block.hr || "Не назначен"}</td>
                  <td className={clsx(styles.tdPrimary, styles.tdCenter)}>{block.arr_of_human.length}</td>
                  <td>
                    <div className={styles.actionsContainer}>
                      <button 
                        className={clsx(styles.actionBtn, styles.actionBtnEdit)} 
                        onClick={(e) => openEditModal(e, block)}
                        title="Редактировать"
                      >
                        <Icon name="edit" size={20} />
                      </button>
                      <button 
                        className={clsx(styles.actionBtn, styles.actionBtnDelete)}
                        onClick={(e) => handleDelete(e, block.name)}
                        title="Удалить"
                      >
                        <Icon name="delete" size={20} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedBlock && (
        <div className={styles.modalOverlay} onClick={() => setSelectedBlockName(null)}>
          <div className={clsx(styles.modal, styles.managementPanel)} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Управление блоком: {selectedBlock.name}</h3>
              <Icon 
                name="close" 
                size={24} 
                style={{ cursor: "pointer" }} 
                onClick={() => setSelectedBlockName(null)} 
              />
            </div>

            <div className={styles.membersSection}>
              <h4>Участники ({selectedBlockMembers.length})</h4>
              <div className={styles.membersList}>
                {selectedBlockMembers.length === 0 && (
                  <div style={{ color: "#888", fontStyle: "italic" }}>В этом блоке пока нет участников</div>
                )}
                {selectedBlockMembers.map(member => (
                  <div key={member.user_id} className={styles.memberItem}>
                    <span className={styles.memberName}>
                      {member.surname} {member.name} {member.patronymic}
                    </span>
                    <span 
                      className={styles.deleteButton}
                      onClick={() => removeMemberMutation.mutate({ 
                        blockName: selectedBlock.name, 
                        userId: member.user_id 
                      })}
                    >
                      <Icon name="person_remove" size={20} />
                      удалить
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className={styles.addMemberSection}>
              <div className={styles.addMemberAutocomplete}>
                <FormikProvider value={addMemberFormik}>
                  <FormAutocompleteField 
                    name="userId" 
                    label="Добавить участника" 
                    options={availablePeopleOptions} 
                  />
                </FormikProvider>
              </div>
              <Button 
                variant="secondary" 
                onClick={() => addMemberFormik.handleSubmit()}
                disabled={!addMemberFormik.values.userId || addMemberMutation.isPending}
              >
                Добавить
              </Button>
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (
        <div className={styles.modalOverlay} onClick={closeModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>{editingBlock ? "Редактировать блок" : "Создать новый блок"}</h3>
              {/* <Icon name="close" size={24} style={{ cursor: "pointer" }} onClick={closeModal} /> */}
            </div>

            <FormikProvider value={formik}>
              <form className={styles.modalForm} onSubmit={formik.handleSubmit}>
                <FormTextField 
                  name="name" 
                  label="Название блока" 
                  disabled={!!editingBlock}
                  color="secondary"
                />
                <FormAutocompleteField name="master" label="Мастер" options={peopleOptions} />
                <FormAutocompleteField name="hr" label="HR" options={peopleOptions} />
                
                {globalError && (
                  <div className={styles.errorText}>
                    {globalError}
                  </div>
                )}
                
                {isSuccess && <div className={styles.successText}>Успешно сохранено!</div>}

                <div className={styles.modalActions}>
                  <Button 
                    variant="secondary"
                    onClick={closeModal}
                  >
                    Отмена
                  </Button>
                  <Button 
                    variant="secondary" 
                    type="submit" 
                    disabled={formik.isSubmitting}
                  >
                    {editingBlock ? "Сохранить" : "Создать"}
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
