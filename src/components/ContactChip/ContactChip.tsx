import React, { useState, useMemo } from 'react';
import { Icon } from '../Icon';
import styles from './ContactChip.module.css';
import clsx from 'clsx';
import { stringifyContent, parseContent } from '../../utils/parsing';

export interface ContactInfo {
  name: string;
  kkr_name: string;
  group: string;
  residence: string;
  blocks: string;
  phone: string;
  vk: string;
  tg: string;
  email: string;
  education: string;
}

interface ContactChipProps {
  initialContent: string;
  mode?: 'view' | 'edit';
  onChange?: (newContent: string) => void;
}



export const ContactChip: React.FC<ContactChipProps> = ({
  initialContent,
  mode = 'view',
  onChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const info = useMemo(() => parseContent(initialContent), [initialContent]);

  const handleToggle = () => setIsOpen(!isOpen);

  const handleInputChange = (key: keyof ContactInfo, value: string) => {
    if (onChange) {
      const newInfo = { ...info, [key]: value };
      onChange(stringifyContent(newInfo));
    }
  };

  const renderField = (label: string, value: string, key: keyof ContactInfo) => {
    if (mode === 'edit') {
      return (
        <div className={styles.field}>
          <label>{label}:</label>
          <input 
            type="text" 
            value={value} 
            onChange={(e) => handleInputChange(key, e.target.value)} 
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={`Введите ${label.toLowerCase()}...`}
          />
        </div>
      );
    }
    return value ? (
      <div className={styles.field}>
        <span className={styles.label}>{label}:</span>
        <span className={styles.value}>{value}</span>
      </div>
    ) : null;
  };

  return (
    <>
      <div className={clsx(styles.chip, mode === 'edit' && styles.editMode)} onClick={handleToggle}>
        <Icon name="person" size={20} />
        <span className={styles.chipText}>
          {info.name || 'Имя'} {info.group ? `(${info.group})` : ''}
        </span>
      </div>

      {isOpen && (
        <div className={styles.modalOverlay} onClick={handleToggle}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Контактная информация</h3>
              <button className={styles.closeBtn} onClick={handleToggle}>
                <Icon name="close" size={24} />
              </button>
            </div>
            <div className={styles.modalBody}>
              {renderField('Имя', info.name, 'name')}
              {renderField('Имя в таблице ККР', info.kkr_name, 'kkr_name')}
              {renderField('Номер группы', info.group, 'group')}
              {renderField('Место жительства', info.residence, 'residence')}
              {renderField('Блоки', info.blocks, 'blocks')}
              {renderField('Телефон', info.phone, 'phone')}
              {renderField('ВК', info.vk, 'vk')}
              {renderField('Телеграмм', info.tg, 'tg')}
              {renderField('Почта', info.email, 'email')}
              {renderField('Форма обучения', info.education, 'education')}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
