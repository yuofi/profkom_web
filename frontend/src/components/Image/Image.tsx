import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './Image.module.css';
import clsx from 'clsx';
import { apiUrl } from '../../utils/api';

interface ImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  disableModal?: boolean;
}

export const Image: React.FC<ImageProps> = ({ className, disableModal, onClick, src, ...rest }) => {
  const props = { ...rest, src: apiUrl(src) };
  const [isOpen, setIsOpen] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    close.current?.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
      if (e.key === 'Tab') { e.preventDefault(); close.current?.focus(); }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
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
        role={!disableModal ? 'button' : undefined}
        tabIndex={!disableModal ? 0 : undefined}
        onKeyDown={e => { if (!disableModal && ['Enter', ' '].includes(e.key)) { e.preventDefault(); setIsOpen(true); } }}
        {...props} 
      />
      {isOpen && createPortal(
        <div className={styles.modalOverlay} onClick={handleClose}>
          <div className={styles.modalContent} role="dialog" aria-modal="true" aria-label="Просмотр изображения" onClick={(e) => e.stopPropagation()}>
            <img className={styles.modalImage} {...props} />
            <button ref={close} type="button" className={styles.closeButton} aria-label="Закрыть изображение" onClick={handleClose}>
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
