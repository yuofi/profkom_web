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
    // 1. Выбираем, какую иконку использовать
    // Если передана customIcon, оборачиваем её в span, чтобы стили не ломались.
    // Иначе используем стандартную <Icon />
    const iconContent = customIcon ? (
      <span className={styles.icon}>{customIcon}</span>
    ) : (
      <Icon name={iconName} className={styles.icon} size={24} />
    );

    // 2. Оборачиваем в фон, если выбрана 3-я вариация
    if (variant === "iconBg") {
      return (
        <div className={styles.iconWrapper}>
          {iconContent}
        </div>
      );
    }
    
    // 3. Возвращаем просто иконку для 1-й и 2-й вариации
    return iconContent;
  };

  return (
    <div className={clsx(styles.chip, styles[variant])}>
      {renderIcon()}
      <span>{children}</span>
    </div>
  );
};