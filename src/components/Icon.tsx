import clsx from "clsx";
import React from "react";

interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
  name: string;
  filled?: boolean;
  size?: number;
  className?: string;
}

export const Icon = ({
  name,
  filled = false,
  size = 24,
  className = "",
  style,
  ...props
}: IconProps) => {
  return (
    <span
      className={clsx(`material-symbols-rounded ${className}`, "icon")}
      style={{
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' ${size}`,
        fontSize: `${size}px`,
        ...style,
      }}
      {...props}
    >
      {name}
    </span>
  );
};
