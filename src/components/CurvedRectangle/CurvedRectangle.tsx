import { type FC, type ReactNode, useId } from "react";
import clsx from "clsx";
import styles from "./CurvedRectangle.module.css";

interface CurvedRectangleProps {
  children?: ReactNode;
  theme?: "dark" | "gradient";
  className?: string;
  customPathStr?: string;
  customPathWidth?: number;  
  customPathHeight?: number; 
  cutoutPosition?: "bottom-left" | "bottom-right";
}

export const CurvedRectangle: FC<CurvedRectangleProps> = ({ 
  children, 
  theme = "dark",
  className,
  customPathStr,
  customPathWidth,
  customPathHeight,
  cutoutPosition
}) => {
  const showPatch = !!cutoutPosition;
  const rawId = useId().replace(/:/g, ""); 
  const clipId = `clip-${rawId}`;

  const scaleX = customPathWidth ? 1 / customPathWidth : 1;
  const scaleY = customPathHeight ? 1 / customPathHeight : 1;
  const hasCustomClip = customPathStr && customPathWidth && customPathHeight;

  return (
    <div className={clsx(styles.card, className)}>
      
      <div className={styles.darkBg} />

      {theme === "gradient" && (
        <>
          {hasCustomClip && (
            <svg width="0" height="0" style={{ position: "absolute", width: 0, height: 0 }}>
              <clipPath id={clipId} clipPathUnits="objectBoundingBox">
                <path 
                  d={customPathStr} 
                  transform={`scale(${scaleX}, ${scaleY})`} 
                />
              </clipPath>
            </svg>
          )}

          <div 
            className={styles.gradientLayer}
            style={hasCustomClip ? { 
              clipPath: `url(#${clipId})`, 
              WebkitClipPath: `url(#${clipId})` 
            } : undefined}
          >
            <div className={styles.noise} />
          </div>
        </>
      )}

      {showPatch && (
        <div className={clsx(
          styles.cutout, 
          cutoutPosition === "bottom-left" ? styles.cutoutLeft : styles.cutoutRight
        )} />
      )}

      <div className={styles.content}>
        {children}
      </div>
      
    </div>
  );
};