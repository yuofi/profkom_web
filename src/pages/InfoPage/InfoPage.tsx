import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { contactsApi } from '../../utils/api/contacts.api';
import { ContactDirectory, type FilterCriteria } from '../../components/ContactDirectory/ContactPage';
import { ContactChip, type ContactInfo } from '../../components/ContactChip/ContactChip';
import { useMe } from '../../utils/me';
import { parseContent, stringifyContent } from '../../utils/parsing';
import type { ContactInfoOut, ProfileUpdate } from '../../utils/api/types';
import styles from './InfoPage.module.css';

const mapContactToInfo = (contact: ContactInfoOut): ContactInfo => {
  return {
    surname: contact.surname || '',
    name: contact.name || '',
    patronymic: contact.patronymic || '',
    kkr_name: contact.kkr_name || '',
    group: contact.group_number || '',
    residence: contact.location || '',
    blocks: contact.blocks || '',
    phone: contact.phone || '',
    vk: contact.vk || '',
    tg: contact.tg || '',
    email: contact.email || '',
    education: contact.budget ? 'Бюджет' : 'Контракт',
    photo_url: contact.photo_url || '',
  };
};

const matchesFilters = (info: ContactInfo, filters: FilterCriteria[]): boolean => {
  if (filters.length === 0) return true;

  return filters.every((filter) => {
    const value = String(info[filter.field] || "").toLowerCase();
    const search = filter.value.toLowerCase();

    if (filter.field === 'group' && search.includes('-')) {
      const [minStr, maxStr] = search.split('-');
      const min = parseInt(minStr);
      const max = parseInt(maxStr);
      const current = parseInt(value);
      
      if (!isNaN(min) && !isNaN(max) && !isNaN(current)) {
        return current >= min && current <= max;
      }
    }

    return value.includes(search);
  });
};

export const InfoPage = () => {
  const [activeFilters, setActiveFilters] = useState<FilterCriteria[]>([]);
  const [editingContents, setEditingContents] = useState<Record<number, string>>({});
  const me = useMe();
  const queryClient = useQueryClient();

  const isSuperAdmin = me?.super_user || false;

  const { data: contacts, isLoading, isError } = useQuery({
    queryKey: ['contacts'],
    queryFn: contactsApi.getAll,
  });

  const updateMutation = useMutation({
    mutationFn: ({ userId, data }: { userId: number, data: ProfileUpdate }) => 
      contactsApi.update(userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['currentUser'] });
      alert('Профиль успешно обновлен');
    },
    onError: (error) => {
      console.error('Ошибка при обновлении профиля:', error);
      alert('Не удалось обновить профиль');
    }
  });

  const filteredContacts = useMemo(() => {
    if (!contacts) return [];
    return contacts.filter(contact => {
      const info = mapContactToInfo(contact);
      return matchesFilters(info, activeFilters);
    });
  }, [contacts, activeFilters]);

  const handleChipChange = (userId: number, newContent: string) => {
    setEditingContents(prev => ({ ...prev, [userId]: newContent }));
  };

  const handleSave = (userId: number) => {
    const content = editingContents[userId];
    if (!content) return;

    const parsed = parseContent(content);
    
    const updateData: ProfileUpdate = {
      surname: parsed.surname,
      name: parsed.name,
      patronymic: parsed.patronymic,
      kkr_name: parsed.kkr_name,
      group_number: parsed.group,
      location: parsed.residence,
      blocks: parsed.blocks,
      phone: parsed.phone,
      vk: parsed.vk,
      tg: parsed.tg,
      email: parsed.email,
      budget: parsed.education === 'Бюджет',
      photo_url: parsed.photo_url,
    };

    updateMutation.mutate({ userId, data: updateData });
  };

  if (isLoading) return <div className={styles.container}>Загрузка контактов...</div>;
  if (isError) return <div className={styles.container}>Ошибка при загрузке контактов.</div>;

  return (
    <div className={styles.container}>
      <article className={styles.mainContent}>
        <h1 className={styles.title}>Контакнтая информация</h1>
        <div className={styles.chipList}>
          {filteredContacts.sort((a, b) => a.surname.localeCompare(b.surname)).map(contact => {
            const initialContent = stringifyContent(mapContactToInfo(contact));
            const currentContent = editingContents[contact.user_id] || initialContent;
            
            return (
              <ContactChip 
                key={contact.user_id}
                initialContent={currentContent}
                mode={isSuperAdmin ? 'edit' : 'view'}
                onChange={(newContent) => handleChipChange(contact.user_id, newContent)}
                onSave={() => handleSave(contact.user_id)}
                disabledFields={['blocks']}
              />
            );
          })}
          {filteredContacts.length === 0 && (
            <p>Контакты не найдены по заданным фильтрам.</p>
          )}
        </div>
      </article>

      <aside className={styles.rightSidebar}>
        <ContactDirectory 
          activeFilters={activeFilters} 
          onFiltersChange={setActiveFilters} 
        />
      </aside>
    </div>
  );
};
