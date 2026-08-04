import React from 'react';
import clsx from 'clsx';
// import { CardLabel } from '../CardLabel/CardLabel';
// import { useMediaQuery } from '../../utils/hooks/useMediaQuery';
import styles from './GuideChip.module.css';

export interface GuideChipProps {
  title: string;
  owner_block?: string;
  description?: string;
  guideId?: number | string;
  mode?: 'view' | 'edit';
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
}

export const GuideChip: React.FC<GuideChipProps> = ({
  title,
  // owner_block,
  description,
  onClick,
  className,
}) => {
  // const isMobile = useMediaQuery('(max-width: 768px)');
  // const currentBlock = owner_block;

  // const displayBlock = currentBlock && currentBlock.toLowerCase() !== 'none' && currentBlock.toLowerCase() !== 'all'
  //   ? currentBlock
  //   : 'Глобальный';

  return (
    <div
      className={clsx(styles.chip, className)}
      onClick={onClick}
    >
      <div className={styles.chipInfo}>
        <span className={styles.chipText}>{title || 'Без названия'}</span>
        <div className={styles.chipTags}>
          {/* <CardLabel variant="tertiary" fontSize={12}>
            {displayBlock}
          </CardLabel> */}
        </div>
        {description && (
          <p className={styles.description}>{description}</p>
        )}
      </div>
    </div>
  );
};
