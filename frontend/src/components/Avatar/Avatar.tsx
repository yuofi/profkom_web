import React, { useRef, useState } from 'react';
import { Icon } from '../Icon';
import { uploadImage } from '../../utils/s3-utils';
import styles from './Avatar.module.css';
import clsx from 'clsx';
import { Image } from '../Image/Image';

interface AvatarProps {
  src?: string;
  size?: number;
  mode?: 'view' | 'edit';
  onUpload?: (url: string) => void;
  className?: string;
}

export const Avatar: React.FC<AvatarProps> = ({
  src,
  size = 64,
  mode = 'view',
  onUpload,
  className
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && onUpload) {
      setIsUploading(true);
      try {
        const url = await uploadImage('avatars', file);
        onUpload(url);
      } catch (error) {
        console.error('Failed to upload image', error);
      } finally {
        setIsUploading(false);
      }
    }
  };

  const triggerUpload = () => {
    if (mode === 'edit' && !isUploading) {
      fileInputRef.current?.click();
    }
  };

  const renderContent = () => {
    if (isUploading) {
      return <div className={styles.loader} />;
    }

    const imageSrc = src?.trim();

    if (imageSrc) {
      return <Image src={imageSrc} alt="Avatar" className={styles.image} disableModal={mode === 'edit'} />;
    }

    return <Icon name="account_circle" size={size} filled={true} />;
  };

  return (
    <div 
      className={clsx(styles.avatar, mode === 'edit' && styles.editable, className)}
      style={{ 
        width: size, 
        height: size,
        '--avatar-size': `${size}px` 
      } as React.CSSProperties}
      onClick={triggerUpload}
    >
      {renderContent()}
      
      {mode === 'edit' && !isUploading && (
        <div className={styles.overlay}>
          <Icon name="add_a_photo" size={size * 0.4} />
        </div>
      )}
      
      <input 
        type="file" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        accept="image/*" 
        onChange={handleFileChange} 
      />
    </div>
  );
};
