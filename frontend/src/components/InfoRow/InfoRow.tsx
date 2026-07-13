import type { ReactNode } from "react";
import clsx from "clsx";
import styles from "./InfoRow.module.css";

interface InfoRowProps {
  title: string;
  date: string;
  
  icon: ReactNode;
  rightContent?: ReactNode;

  onClick?: () => void;
  className?: string;
}

export const InfoRow = ({ 
  title, 
  date, 
  icon, 
  rightContent, 
  onClick, 
  className="" 
}: InfoRowProps) => {
  return (
    <div className={clsx(styles.row, className)} onClick={onClick}>
      
      <div className={styles.left}>
        <div className={styles.iconWrapper}>
          {icon}
        </div>
        
        <div className={styles.textWrapper}>
          <span className={styles.title}>{title}</span>
          <span className={styles.subtitle}>{date}</span>
        </div>
      </div>

      {rightContent && (
        <div className={styles.right}>
          {rightContent}
        </div>
      )}
      
    </div>
  );
};