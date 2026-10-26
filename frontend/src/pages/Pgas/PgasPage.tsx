import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useMemo, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { z } from "zod";
import { FormikProvider } from "formik";
import { useGuardedAction } from "../../components/Workspace/unsavedChangesHooks";
import { pgasApi } from "../../utils/api/pgas.api";
import { apiUrl } from "../../utils/api";
import { uploadFile } from "../../utils/s3-utils";
import { fileAccept, fileMetadata } from "../../utils/filePolicy";
import { can, useSession } from "../../utils/session";
import { useForm } from "../../components/Form/Form";
import { Badge, Empty, Glyph, Loading, Page } from "../../components/Workspace/WorkspaceUI";
import type { PgasEntryOut } from "../../utils/api/types";
import s from "../../components/Workspace/Workspace.module.css";
import styles from "./PgasPage.module.css";
import type { IconName } from "../../components/icons";

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

const getFileIcon = (fileType = ""): IconName => {
  if (fileType.includes("pdf")) return "picture_as_pdf";
  if (fileType.startsWith("image/")) return "image";
  return "description";
};

export const PgasPage = () => {
  const queryClient = useQueryClient();
  const scope = useId();
  const requestClose = useGuardedAction(scope);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sortType, setSortType] = useState<SortType>("default");

  const { session } = useSession();
  // The chair, deputies and pgas_admin edit (decision 14); the server decides it.
  const canManage = can(session, "manage_pgas");

  const { data: entries, isLoading, isError } = useQuery({
    queryKey: ["pgas"],
    queryFn: pgasApi.getAll,
  });

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
    protectChanges: { enabled: isModalOpen, scope, label: "Документ ПГАС", externalDirty: !!selectedFile, externalBusy: createMutation.isPending, discard: () => resetFile() },
    onSubmit: async (values) => {
      await createMutation.mutateAsync(values);
    },
  });
  const isSaving = formik.isSubmitting || createMutation.isPending;

  const resetFile = () => {
    setSelectedFile(null);
    setFileError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const openModal = () => {
    if (isSaving) return;
    resetFile();
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    resetFile();
    formik.resetForm();
  };

  const requestModalClose = () => {
    if (!isSaving) requestClose(closeModal);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isSaving) return;
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      fileMetadata("pgas", file);
    } catch (error) {
      setSelectedFile(null);
      setFileError(error instanceof Error ? error.message : "Неподдерживаемый файл");
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

  return (
    <Page
      title="ПГАС"
      description="Документы для ПГАС"
      actions={
        canManage && (
          <button className={s.button} disabled={isSaving} onClick={openModal}>
            <Glyph name="upload" />
            Загрузить файл
          </button>
        )
      }
    >
      <Helmet>
        <title>ПГАС | Профком ВМК</title>
      </Helmet>
      <div className={s.filters}>
        <label className={s.field}>
          Порядок
          <select value={sortType} onChange={(e) => setSortType(e.target.value as SortType)}>
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError ? (
        <div role="alert" className={s.error}>
          <p>Не удалось загрузить список</p>
        </div>
      ) : sortedEntries.length === 0 ? (
        <Empty>Записи пока не добавлены</Empty>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>Название мероприятия</th>
                <th>Год</th>
                <th>Файл</th>
                {canManage && <th aria-label="Действия"></th>}
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => (
                <tr key={entry.entry_id}>
                  <td>{entry.title}</td>
                  <td>
                    <Badge tone="yellow">{entry.year}</Badge>
                  </td>
                  <td>
                    <a
                      className={styles.fileLink}
                      href={apiUrl(entry.file_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                    >
                      <Glyph name={getFileIcon(entry.file_type)} />
                      <span className={styles.fileName}>
                        {entry.file_name || "Скачать"}
                      </span>
                    </a>
                  </td>
                  {canManage && (
                    <td>
                      <button
                        className={`${s.button} ${s.danger} ${styles.deleteButton}`}
                        onClick={() => handleDelete(entry)}
                        title="Удалить"
                        aria-label={`Удалить запись «${entry.title}»`}
                      >
                        <Glyph name="delete" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isModalOpen && (
        <div className={styles.modalOverlay} onClick={requestModalClose}>
          <div
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pgas-upload-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader}>
              <h3 id="pgas-upload-title">Загрузить файл</h3>
              <button type="button" className={s.button} disabled={isSaving} onClick={requestModalClose} aria-label="Закрыть">
                <Glyph name="close" />
              </button>
            </div>

            <FormikProvider value={formik}>
              <form className={s.form} onSubmit={formik.handleSubmit}>
                <fieldset className={s.formFields} disabled={isSaving}>
                  <label className={s.field}>
                    Название мероприятия
                    <input
                      name="title"
                      value={formik.values.title}
                      onChange={formik.handleChange}
                      onBlur={formik.handleBlur}
                    />
                    {formik.touched.title && formik.errors.title && (
                      <span className={s.fieldError}>{String(formik.errors.title)}</span>
                    )}
                  </label>

                  <label className={s.field}>
                    Год
                    <select
                      name="year"
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
                    {formik.touched.year && formik.errors.year && (
                      <span className={s.fieldError}>{String(formik.errors.year)}</span>
                    )}
                  </label>

                  <div className={styles.fileField}>
                    <button
                      type="button"
                      className={s.button}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Glyph name="attach_file" />
                      Выбрать файл
                    </button>
                    <span className={styles.chosenFileName}>
                      {selectedFile ? selectedFile.name : "Файл не выбран"}
                    </span>
                    <input
                      type="file"
                      ref={fileInputRef}
                      style={{ display: "none" }}
                      accept={fileAccept("pgas")}
                      onChange={handleFileChange}
                    />
                  </div>

                  {fileError && <p role="alert" className={s.fieldError}>{fileError}</p>}

                  {globalError && <p role="alert" className={s.fieldError}>{globalError}</p>}

                  <div className={styles.modalActions}>
                    <button className={s.button} type="button" onClick={requestModalClose}>
                      Отмена
                    </button>
                    <button
                      className={`${s.button} ${s.primary}`}
                      type="submit"
                      disabled={formik.isSubmitting}
                    >
                      {formik.isSubmitting ? "Загрузка..." : "Загрузить"}
                    </button>
                  </div>
                </fieldset>
              </form>
            </FormikProvider>
          </div>
        </div>
      )}
    </Page>
  );
};
