import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { z } from "zod";
import { FormikProvider } from "formik";
import clsx from "clsx";
import { pgasApi } from "../../utils/api/pgas.api";
import { uploadFile } from "../../utils/s3-utils";
import { useMe } from "../../utils/me";
import { Icon } from "../../components/Icon";
import { Button } from "../../components/Button/Button";
import { FormTextField } from "../../components/Form/FormTextFiled";
import { useForm } from "../../components/Form/Form";
import type { PgasEntryOut } from "../../utils/api/types";
import styles from "./PgasPage.module.css";

// Бэкенд принимает в папку "pgas" только эти типы файлов
const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 МБ

const CURRENT_YEAR = new Date().getFullYear();
// Годы для выпадающего списка: следующий год и семь предыдущих
const YEAR_OPTIONS = Array.from({ length: 9 }, (_, i) => CURRENT_YEAR + 1 - i);

type SortType = "default" | "alphabet" | "year";

const SORT_OPTIONS: Array<{ value: SortType; label: string }> = [
  { value: "default", label: "По умолчанию" },
  { value: "alphabet", label: "По алфавиту" },
  { value: "year", label: "По году" },
];

const PgasValidationSchema = z.object({
  title: z.string().min(1, "Название мероприятия обязательно"),
  year: z
    .number({ message: "Выберите год" })
    .int()
    .min(1900, "Некорректный год")
    .max(2200, "Некорректный год"),
});

const getFileIcon = (fileType = "") => {
  if (fileType.includes("pdf")) return "picture_as_pdf";
  if (fileType.startsWith("image/")) return "image";
  return "description";
};

export const PgasPage = () => {
  const me = useMe();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sortType, setSortType] = useState<SortType>("default");
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const canManage = Boolean(me?.pgas_admin || me?.super_user);

  const { data: entries, isLoading, isError } = useQuery({
    queryKey: ["pgas"],
    queryFn: pgasApi.getAll,
  });

  // Закрываем выпадающий список фильтрации по клику вне него
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setIsFilterOpen(false);
      }
    };

    if (isFilterOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [isFilterOpen]);

  const sortedEntries = useMemo(() => {
    if (!entries) return [];

    const result = [...entries];

    if (sortType === "alphabet") {
      result.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    } else if (sortType === "year") {
      result.sort((a, b) => b.year - a.year);
    }

    // "По умолчанию" — порядок, в котором записи лежат в базе (новые первыми)
    return result;
  }, [entries, sortType]);

  const createMutation = useMutation({
    mutationFn: async (values: { title: string; year: number }) => {
      if (!selectedFile) {
        throw new Error("Прикрепите файл");
      }
      const file_url = await uploadFile("pgas", selectedFile);
      return pgasApi.create({
        title: values.title,
        year: values.year,
        file_url,
        file_name: selectedFile.name,
        file_type: selectedFile.type,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pgas"] });
      closeModal();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: pgasApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pgas"] });
    },
  });

  const { formik, globalError } = useForm({
    initialValues: {
      title: "",
      year: CURRENT_YEAR,
    },
    validationSchema: PgasValidationSchema,
    onSubmit: async (values) => {
      await createMutation.mutateAsync(values);
    },
  });

  const resetFile = () => {
    setSelectedFile(null);
    setFileError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const openModal = () => {
    resetFile();
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    resetFile();
    formik.resetForm();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_FILE_TYPES.includes(file.type)) {
      setSelectedFile(null);
      setFileError("Допустимы только файлы формата PDF, PNG или JPG");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelectedFile(null);
      setFileError("Файл слишком большой, максимальный размер — 20 МБ");
      return;
    }

    setFileError(null);
    setSelectedFile(file);
  };

  const handleDelete = (entry: PgasEntryOut) => {
    if (window.confirm(`Вы уверены, что хотите удалить запись "${entry.title}"?`)) {
      deleteMutation.mutate(entry.entry_id);
    }
  };

  if (isLoading) {
    return (
      <div className={styles.pgasPage}>
        <Helmet>
          <title>ПГАС | Профком ВМК</title>
        </Helmet>
        <div className={styles.emptyState}>
          <Icon name="sync" size={32} />
          <span>Загрузка списка...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pgasPage}>
      <Helmet>
        <title>ПГАС | Профком ВМК</title>
      </Helmet>

      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderText}>
          <h1 className={styles.pageTitle}>ПГАС</h1>
          <p className={styles.pageSubtitle}>
            Документы на повышенную государственную академическую стипендию
          </p>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.filterWrapper} ref={filterRef}>
            <button
              className={clsx(styles.filterBtn, isFilterOpen && styles.filterBtnActive)}
              onClick={() => setIsFilterOpen(!isFilterOpen)}
            >
              <Icon name="filter_list" size={20} />
              Фильтрация
              <Icon name={isFilterOpen ? "expand_less" : "expand_more"} size={20} />
            </button>

            {isFilterOpen && (
              <div className={styles.filterDropdown}>
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    className={clsx(
                      styles.filterOption,
                      sortType === option.value && styles.filterOptionActive,
                    )}
                    onClick={() => {
                      setSortType(option.value);
                      setIsFilterOpen(false);
                    }}
                  >
                    {option.label}
                    {sortType === option.value && <Icon name="check" size={18} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {canManage && (
            <button className={styles.uploadBtn} onClick={openModal}>
              <Icon name="upload" size={20} />
              Загрузить файл
            </button>
          )}
        </div>
      </div>

      {isError ? (
        <div className={styles.emptyState}>
          <Icon name="error" size={48} />
          <span>Не удалось загрузить список</span>
        </div>
      ) : sortedEntries.length === 0 ? (
        <div className={styles.emptyState}>
          <Icon name="folder_open" size={48} />
          <span>Записи пока не добавлены</span>
        </div>
      ) : (
        <section className={styles.tableContainer}>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Название мероприятия</th>
                  <th>Год</th>
                  <th>Файл</th>
                  {canManage && <th></th>}
                </tr>
              </thead>
              <tbody>
                {sortedEntries.map((entry) => (
                  <tr key={entry.entry_id}>
                    <td className={styles.tdPrimary}>{entry.title}</td>
                    <td>
                      <span className={styles.chip}>{entry.year}</span>
                    </td>
                    <td>
                      <a
                        className={styles.fileLink}
                        href={entry.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                      >
                        <Icon name={getFileIcon(entry.file_type)} size={20} />
                        <span className={styles.fileName}>
                          {entry.file_name || "Скачать"}
                        </span>
                      </a>
                    </td>
                    {canManage && (
                      <td>
                        <div className={styles.actionsContainer}>
                          <button
                            className={styles.actionBtn}
                            onClick={() => handleDelete(entry)}
                            title="Удалить"
                          >
                            <Icon name="delete" size={20} />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isModalOpen && (
        <div className={styles.modalOverlay} onClick={closeModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Загрузить файл</h3>
              <Icon
                name="close"
                size={24}
                style={{ cursor: "pointer" }}
                onClick={closeModal}
              />
            </div>

            <FormikProvider value={formik}>
              <form className={styles.modalForm} onSubmit={formik.handleSubmit}>
                <FormTextField
                  name="title"
                  label="Название мероприятия"
                  color="secondary"
                />

                <div className={styles.selectField}>
                  <span className={styles.fieldLabel}>Год</span>
                  <select
                    name="year"
                    className={styles.select}
                    value={formik.values.year}
                    onChange={(e) => formik.setFieldValue("year", Number(e.target.value))}
                    onBlur={formik.handleBlur}
                  >
                    {YEAR_OPTIONS.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </div>
                {formik.touched.year && formik.errors.year && (
                  <div className={styles.errorText}>{String(formik.errors.year)}</div>
                )}

                <div className={styles.fileField}>
                  <button
                    type="button"
                    className={styles.chooseFileBtn}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Icon name="attach_file" size={20} />
                    Выбрать файл
                  </button>
                  <span className={styles.chosenFileName}>
                    {selectedFile ? selectedFile.name : "Файл не выбран"}
                  </span>
                  <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: "none" }}
                    accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
                    onChange={handleFileChange}
                  />
                </div>

                {fileError && <div className={styles.errorText}>{fileError}</div>}

                {globalError && <div className={styles.errorText}>{globalError}</div>}

                <div className={styles.modalActions}>
                  <Button variant="tertiary" type="reset" onClick={closeModal}>
                    Отмена
                  </Button>
                  <Button
                    variant="tertiary"
                    type="submit"
                    disabled={formik.isSubmitting}
                  >
                    {formik.isSubmitting ? "Загрузка..." : "Загрузить"}
                  </Button>
                </div>
              </form>
            </FormikProvider>
          </div>
        </div>
      )}
    </div>
  );
};
