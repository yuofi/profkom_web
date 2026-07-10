import type { ReactNode } from "react";
import styles from "./InfoBadge.module.css";

interface InfoBadgeProps {
  title: string;
  actionLabel?: string;

  onClick?: () => void;
  children: ReactNode;
}

export const InfoBadge = ({
  title,
  actionLabel,
  onClick,
  children,
}: InfoBadgeProps) => {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h5 className={styles.title}>{title}</h5>
        {actionLabel && (
          <button className={styles.actionLink} onClick={onClick} type="button">
            {actionLabel}
          </button>
        )}
      </div>
      <div className={styles.list}>{children}</div>
    </div>
  );
};
