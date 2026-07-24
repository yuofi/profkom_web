import { type ReactNode } from "react";
import clsx from "clsx";
import styles from "./ProfileChip.module.css";
import { Icon } from "../Icon";

interface ProfileChipProps {
  variant?: "minimal" | "primary" | "iconBg" | "highlighted";
  children: ReactNode;
  iconName?: string;        // Для стандартных иконок Google
  customIcon?: ReactNode; 
  label?: ReactNode;
}

export const ProfileChip = ({ 
  variant = "minimal", 
  children, 
  iconName = "chart-line",
  customIcon,
  label
}: ProfileChipProps) => {

  const iconContent = customIcon ? (
    <>{customIcon}</>
  ) : (
    <Icon name={iconName} className={styles.icon} size={24} />
  );

  if (variant === "iconBg") {
    return (
      <div className={styles.fieldView}>
        <div className={styles.fieldIcon}>
          {iconContent}
        </div>
        <div className={styles.fieldContent}>
          {label && <span className={styles.label}>{label}</span>}
          <span className={styles.value}>{children}</span>
        </div>
      </div>
    );
  }

  const renderIcon = () => {
    if (variant === "highlighted") {
      return (
        <div className={styles.iconHighlighted}>
          {iconContent}
        </div>
      );
    }
    
    return iconContent;
  };

  return (
    <div className={clsx(styles.chip, styles[variant], !children && styles.iconOnly)}>
      {renderIcon()}
      {Boolean(children) && <span>{children}</span>}
    </div>
  );
};