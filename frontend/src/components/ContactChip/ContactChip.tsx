import React, { useState, useMemo } from 'react';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar/Avatar';
import styles from './ContactChip.module.css';
import clsx from 'clsx';
import { stringifyContent, parseContent } from '../../utils/parsing';
import { useMediaQuery } from '../../utils/hooks/useMediaQuery';
import { CardLabel } from '../CardLabel/CardLabel';
import { TextField } from '../TextField/TextField';
import { Button } from '../Button/Button';

export interface ContactInfo {
  surname: string;
  name: string;
  patronymic: string;
  kkr_name: string;
  group: string;
  residence: string;
  blocks: string;
  phone: string;
  vk: string;
  tg: string;
  email: string;
  education: string;
  photo_url: string;
}

interface ContactChipProps {
  initialContent: string;
  mode?: 'view' | 'edit';
  onChange?: (newContent: string) => void;
  onSave?: () => void;
  disabledFields?: (keyof ContactInfo)[];
  isExternalOpen?: boolean;
  onExternalClose?: () => void;
  hideChip?: boolean;
  }



  export const ContactChip: React.FC<ContactChipProps> = ({
  initialContent,
  mode = 'view',
  onChange,
  onSave,
  disabledFields = [],
  isExternalOpen,
  onExternalClose,
  hideChip = false,
  }) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = isExternalOpen !== undefined ? isExternalOpen : internalOpen;

  const info = useMemo(() => parseContent(initialContent), [initialContent]);
  const isMobile = useMediaQuery("(max-width: 768px)");


  const handleToggle = () => {
    if (isExternalOpen !== undefined) {
      if (onExternalClose && isOpen) onExternalClose();
    } else {
      setInternalOpen(!internalOpen);
    }
  };

  const handleClose = () => {
    if (onExternalClose) {
      onExternalClose();
    } else {
      setInternalOpen(false);
    }
  };

  const handleInputChange = (key: keyof ContactInfo, value: string) => {
    if (onChange && !disabledFields.includes(key)) {
      const newInfo = { ...info, [key]: value };
      onChange(stringifyContent(newInfo));
    }
  };

  const handleSave = () => {
    if (onSave) {
      onSave();
    }
  };

  const renderField = (label: string, value: string, key: keyof ContactInfo, iconName?: string) => {
    const isDisabled = disabledFields.includes(key);

    if (mode === 'edit') {
      if (isDisabled) return null;
      return (
        <TextField 
          label={label}
          value={value} 
          onChange={(e) => handleInputChange(key, e.target.value)} 
          onKeyDown={(e) => e.stopPropagation()}
          className={styles.field}
          color="on-surface"
        />
      );
    }
    return value ? (
      <div className={styles.fieldView}>
        {iconName && <Icon name={iconName} size={20} className={styles.fieldIcon} />}
        <div className={styles.fieldContent}>
          <span className={styles.label}>{label}</span>
          <span className={styles.value}>{value}</span>
        </div>
      </div>
    ) : null;
  };

  return (
    <>
      {!hideChip && (
        <div className={clsx(styles.chip, mode === 'edit' && styles.editMode)} onClick={handleToggle}>
          <Avatar src={info.photo_url} size={isMobile ? 50 : 80} mode="disable" />
          <div className={styles.chipInfo}>
          <span className={styles.chipText}>
            {`${info.surname} ${info.name} ${info.patronymic}`.trim() || 'ФИО'} {info.group ? `(${info.group})` : ''}
          </span>
          <div className={styles.chipTags}>
          {info.blocks.length > 0 && 
          info.blocks.split(",").map((block) => {
            return (
              <CardLabel variant="tertiary" fontSize={12} key={block}>
                  {block}
              </CardLabel>
            )})
          }
          </div>
          </div>
        </div>
      )}

      {isOpen && (
        <div className={styles.modalOverlay} onClick={handleClose}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalBody}>
              <div className={styles.avatarSection}>
                <Avatar 
                  src={info.photo_url} 
                  size={100} 
                  mode={mode} 
                  onUpload={(url) => handleInputChange('photo_url', url)} 
                />
              </div>

              <div className={styles.row}>
                {renderField('Имя', info.name, 'name', 'person')}
                {renderField('Фамилия', info.surname, 'surname', 'person')}
              </div>
              {renderField('Отчество', info.patronymic, 'patronymic', 'person')}
              {renderField('Имя в таблице ККР', info.kkr_name, 'kkr_name', 'badge')}
              {renderField('Номер группы', info.group, 'group', 'groups')}
              <div className={styles.row}>
                {renderField('Место жительства', info.residence, 'residence', 'home')}
                {renderField('Форма обучения', info.education, 'education', 'school')}
              </div>
              {renderField('Блоки', info.blocks, 'blocks', 'layers')}
              {renderField('Телефон', info.phone, 'phone', 'call')}
              <div className={styles.row}>
                {renderField('ВК', info.vk, 'vk', 'share')}
                {renderField('Телеграмм', info.tg, 'tg', 'send')}
              </div>
              {renderField('Почта', info.email, 'email', 'mail')}
            </div>
            {mode === 'edit' && onSave && (
              <div className={styles.modalFooter}>
                <Button variant="primary" onClick={handleSave}>
                  Сохранить
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};
