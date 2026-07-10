import { type ReactNode } from "react";
import clsx from "clsx";
import styles from "./cardLabel.module.css";
import { Icon } from "../Icon";

interface LabelProps {
  variant: "primary" | "black" | "tertiary" | "secondary" | "transparent";
  children: ReactNode;
  iconName?: string;
  fontSize?: number;
}

export const CardLabel = ({ variant, children, iconName, fontSize=14}: LabelProps) => {
  return <div className={clsx(styles.label, styles[variant])}
    style={{
      fontSize: `${fontSize}px`,
    }}
  >
    {iconName && (
        <Icon name={iconName} className={styles.icon} size={fontSize}/>
      )}
    {children}
    </div>;
};
