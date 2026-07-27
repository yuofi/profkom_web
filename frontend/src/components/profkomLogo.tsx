import type { FC } from "react";
import type { MainElementVariant, MainElementProps } from "./componetsTypes";

const WIDTHS: Record<MainElementVariant, number> = {
    desktop: 44,
    mobile: 32
}


const ProfkomLogo: FC<MainElementProps & { width?: number; strokeWidth?: number }> = ({
  variant = "desktop",
  width,
  strokeWidth: customStrokeWidth,
  ...props
}) => {
  if (!width) {
    width = WIDTHS[variant];
  }


  const strokeWidth = customStrokeWidth ?? (variant === "mobile" ? 6 : 5);

  const height = (width * 454) / 600;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 625 454"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="204" cy="23" r="20.5" stroke="currentColor" strokeWidth={strokeWidth} />
      <line
        x1="212.536"
        y1="176"
        x2="237.284"
        y2="200.749"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <line
        x1="335.536"
        y1="310"
        x2="360.284"
        y2="334.749"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <line
        x1="233.536"
        y1="152"
        x2="258.284"
        y2="176.749"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <line
        x1="356.536"
        y1="286"
        x2="381.284"
        y2="310.749"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <line
        x1="256.536"
        y1="130"
        x2="281.284"
        y2="154.749"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <line
        x1="379.536"
        y1="264"
        x2="404.284"
        y2="288.749"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M239 356L112.357 230.335C111.011 228.999 110.338 228.332 110.337 227.499C110.337 226.667 111.009 225.998 112.353 224.661L311.672 26.3146C313.005 24.9875 313.672 24.324 314.499 24.325C315.326 24.326 315.991 24.9912 317.322 26.3215L336 45"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M388 98L516.071 225.082C516.859 225.864 516.86 227.137 516.073 227.92L313.914 429.093C313.133 429.87 311.869 429.869 311.089 429.089L291 409"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M434 413.5L620.082 227.914C620.865 227.133 620.866 225.866 620.084 225.084L417.911 22.9108C417.131 22.1311 415.867 22.1295 415.086 22.9073L211.935 225.072C211.145 225.858 211.15 227.137 211.946 227.918L312.5 326.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M191 38.9307L4.42124 224.586C3.63688 225.366 3.63531 226.635 4.41773 227.418L206.589 429.589C207.369 430.369 208.633 430.37 209.414 429.593L412.565 227.428C413.355 226.642 413.35 225.363 412.554 224.582L312 126"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <circle cx="420" cy="431" r="20.5" stroke="currentColor" strokeWidth={strokeWidth} />
    </svg>
  );
};

export default ProfkomLogo;
