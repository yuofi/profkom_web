import React, { useState, useEffect } from 'react';
import { Swiper, SwiperSlide } from 'swiper/react';
import { Navigation, Pagination } from 'swiper/modules';
import { uploadImage } from '../../utils/s3-utils';
import { Icon } from '../Icon';
import styles from './Gallery.module.css';

import 'swiper/css';
import 'swiper/css/navigation';
import 'swiper/css/pagination';

interface GalleryItem {
  src: string;
  caption: string;
}

interface GalleryProps {
  initialContent: string;
  mode?: 'view' | 'edit';
  onChange?: (newContent: string) => void;
}

export const Gallery: React.FC<GalleryProps> = ({ 
  initialContent, 
  mode = 'view', 
  onChange 
}) => {
  const [items, setItems] = useState<GalleryItem[]>([]);

  useEffect(() => {
    const parsedItems = initialContent
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        const [src, caption] = line.split('|');
        return { 
          src: src.trim(), 
          caption: caption ? caption.trim() : '' 
        };
      });
    
    // Only update if the content is actually different to avoid cursor jumps
    const currentContent = items
      .map(item => `${item.src}${item.caption ? `|${item.caption}` : ''}`)
      .join('\n');
    
    if (initialContent.trim() !== currentContent.trim()) {
      setItems(parsedItems);
    }
  }, [initialContent]);

  const updateContent = (newItems: GalleryItem[]) => {
    setItems(newItems);
    if (onChange) {
      const newContent = newItems
        .map(item => `${item.src}${item.caption ? `|${item.caption}` : ''}`)
        .join('\n');
      onChange(newContent);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    try {
      const newItems = [...items];
      for (let i = 0; i < files.length; i++) {
        const url = await uploadImage('gallery', files[i]);
        newItems.push({ src: url, caption: '' });
      }
      updateContent(newItems);
    } catch (error) {
      console.error('Upload failed', error);
    }
  };

  const handleRemove = (index: number) => {
    const newItems = items.filter((_, i) => i !== index);
    updateContent(newItems);
  };

  const handleCaptionChange = (index: number, caption: string) => {
    const newItems = [...items];
    newItems[index].caption = caption;
    updateContent(newItems);
  };

  return (
    <div className={styles.carouselContainer}>
      <Swiper
        modules={[Navigation, Pagination]}
        navigation={true}
        pagination={{ clickable: true }}
        spaceBetween={20}
        slidesPerView={1}
        className={styles.swiper}
      >
        {items.map((item, index) => (
          <SwiperSlide key={index}>
            <figure className={styles.carouselFigure}>
              <div className={styles.imageWrapper}>
                <img src={item.src} alt={item.caption || 'Слайд'} />
                {mode === 'edit' && (
                  <button 
                    className={styles.removeBtn} 
                    onClick={() => handleRemove(index)}
                    title="Удалить фото"
                  >
                    <Icon name="delete" size={20} />
                  </button>
                )}
              </div>
              
              {mode === 'view' ? (
                item.caption && <figcaption>{item.caption}</figcaption>
              ) : (
                <input 
                  type="text" 
                  value={item.caption} 
                  onChange={(e) => handleCaptionChange(index, e.target.value)}
                  placeholder="Описание фотографии..."
                  className={styles.captionInput}
                />
              )}
            </figure>
          </SwiperSlide>
        ))}
        
        {mode === 'edit' && items.length === 0 && (
          <SwiperSlide>
            <div className={styles.uploadSlide}>
              <label className={styles.uploadLabel}>
                <Icon name="add_a_photo" size={48} />
                <span>Нажмите, чтобы добавить фото</span>
                <input 
                  type="file" 
                  accept="image/*" 
                  multiple 
                  onChange={handleUpload} 
                  hidden 
                />
              </label>
            </div>
          </SwiperSlide>
        )}
      </Swiper>

      {mode === 'edit' && items.length > 0 && (
        <label className={styles.floatingAddBtn} title="Добавить фото">
          <Icon name="add_a_photo" size={24} />
          <input 
            type="file" 
            accept="image/*" 
            multiple 
            onChange={handleUpload} 
            hidden 
          />
        </label>
      )}
    </div>
  );
};
