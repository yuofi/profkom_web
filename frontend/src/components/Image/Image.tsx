import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './Image.module.css';
import clsx from 'clsx';

interface ImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  disableModal?: boolean;
}

export const Image: React.FC<ImageProps> = ({ className, disableModal, onClick, ...props }) => {
  const [isOpen, setIsOpen] = useState(false);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'auto';
    };
  }, [isOpen]);

  const handleClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (onClick) {
      onClick(e);
    }
    if (!disableModal) {
      setIsOpen(true);
    }
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
  };

  return (
    <>
      <img 
        className={clsx(styles.image, !disableModal && styles.zoomable, className)} 
        onClick={handleClick} 
        {...props} 
      />
      {isOpen && createPortal(
        <div className={styles.modalOverlay} onClick={handleClose}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <img className={styles.modalImage} {...props} />
            <button className={styles.closeButton} onClick={handleClose}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
