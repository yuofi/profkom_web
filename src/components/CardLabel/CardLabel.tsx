import { type ReactNode } from "react";
import clsx from "clsx";
import styles from "./cardLabel.module.css";
import { Icon } from "../Icon";

interface LabelProps {
  variant: "primary" | "black" | "tertiary" | "secondary" | "transparent";
  children: ReactNode;
  iconName?: string;
}

export const CardLabel = ({ variant, children, iconName}: LabelProps) => {
  return <div className={clsx(styles.label, styles[variant])}>
    {iconName && (
        <Icon name={iconName} className={styles.icon} size={16}/>
      )}
    {children}
    </div>;
};
