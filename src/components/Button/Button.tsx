import type { MouseEvent, ReactNode } from "react";
import styles from './button.module.css';
import clsx from "clsx";

interface ButtonProps {
  variant: "primary" | "secondary" | "tertiary" | "bordered" | "transparent";
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
  className?: string;
  type?: 'submit' | 'reset';
  disabled: boolean;
}

export const Button = ({ variant, onClick, children, className="", ...props }: ButtonProps) => {
  return (
    <button
    {...props}
    className={clsx(styles.btn, styles[variant], className)}
    onClick={onClick}
    >
      {children}
    </button>
  );
};
