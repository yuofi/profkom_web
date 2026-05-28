import React, { useState } from 'react';
import { type ContactInfo } from '../ContactChip/ContactChip';
import { Icon } from '../Icon';
import styles from './ContactPage.module.css';

export interface FilterCriteria {
  id: string;
  field: keyof ContactInfo;
  value: string;
}

interface FilterPanelProps {
  activeFilters: FilterCriteria[];
  onFiltersChange: (filters: FilterCriteria[]) => void;
}

const FIELD_LABELS: Record<keyof ContactInfo, string> = {
  name: 'Имя',
  kkr_name: 'Имя ККР',
  group: 'Группа',
  residence: 'Место жительства',
  blocks: 'Блоки',
  phone: 'Телефон',
  vk: 'ВК',
  tg: 'ТГ',
  email: 'Почта',
  education: 'Форма обучения',
};

export const ContactDirectory: React.FC<FilterPanelProps> = ({ 
  activeFilters, 
  onFiltersChange 
}) => {
  const [selectedField, setSelectedField] = useState<keyof ContactInfo>('name');
  const [inputValue, setInputValue] = useState('');

  const addFilter = () => {
    if (!inputValue.trim()) return;
    
    const newFilter: FilterCriteria = {
      id: Math.random().toString(36).substr(2, 9),
      field: selectedField,
      value: inputValue.trim(),
    };
    
    onFiltersChange([...activeFilters, newFilter]);
    setInputValue('');
  };

  const removeFilter = (id: string) => {
    onFiltersChange(activeFilters.filter(f => f.id !== id));
  };

  const clearAll = () => {
    onFiltersChange([]);
  };

  return (
    <div className={styles.filterPanel}>
      <div className={styles.panelHeader}>
        <h3>Фильтры</h3>
        {activeFilters.length > 0 && (
          <button className={styles.clearBtn} onClick={clearAll}>
            Очистить
          </button>
        )}
      </div>

      <div className={styles.addFilterRow}>
        <select 
          value={selectedField} 
          onChange={(e) => setSelectedField(e.target.value as keyof ContactInfo)}
          className={styles.select}
        >
          {Object.entries(FIELD_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        
        <div className={styles.inputWrapper}>
          <input
            type="text"
            placeholder="Значение..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFilter()}
            className={styles.searchInput}
          />
          <button className={styles.addBtn} onClick={addFilter} title="Добавить фильтр">
            <Icon name="add" size={20} />
          </button>
        </div>
      </div>

      <div className={styles.activeFilters}>
        {activeFilters.length === 0 ? (
          <p className={styles.emptyHint}>Нет активных фильтров. Добавьте фильтр выше.</p>
        ) : (
          activeFilters.map((filter) => (
            <div key={filter.id} className={styles.filterTag}>
              <span className={styles.filterInfo}>
                <span className={styles.filterField}>{FIELD_LABELS[filter.field]}:</span>
                <span className={styles.filterValue}>{filter.value}</span>
              </span>
              <button className={styles.removeTag} onClick={() => removeFilter(filter.id)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))
        )}
      </div>
      
      <div className={styles.helpText}>
        <small>Можно вводить диапазоны для групп (напр. 101-105) или просто текст для поиска.</small>
      </div>
    </div>
  );
};
