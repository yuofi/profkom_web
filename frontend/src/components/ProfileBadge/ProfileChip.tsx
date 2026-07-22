import { type ReactNode } from "react";
import clsx from "clsx";
import styles from "./ProfileChip.module.css";
import { Icon } from "../Icon";

interface ProfileChipProps {
  variant?: "minimal" | "primary" | "iconBg";
  children: ReactNode;
  iconName?: string;        // Для стандартных иконок Google
  customIcon?: ReactNode;   // НОВЫЙ ПРОПС: Для любых своих иконок (SVG, компоненты)
}

export const ProfileChip = ({ 
  variant = "minimal", 
  children, 
  iconName = "chart-line",
  customIcon
}: ProfileChipProps) => {

  const renderIcon = () => {
    const iconContent = customIcon ? (
      <>{customIcon}</>
    ) : (
      <Icon name={iconName} className={styles.icon} size={24} />
    );

    if (variant === "iconBg") {
      return (
        <div className={styles.iconWrapper}>
          {iconContent}
        </div>
      );
    }
    
    return iconContent;
  };

  return (
    <div className={clsx(styles.chip, styles[variant])}>
      {renderIcon()}
      <span>{children}</span>
    </div>
  );
};