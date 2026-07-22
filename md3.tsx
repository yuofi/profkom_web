import React, { useState, useEffect } from 'react';
import { Camera, ArrowLeft, Shield, X } from 'lucide-react';

// MD3 Outlined Text Field
const MD3Input = ({ label, type = "text", defaultValue, id, required }) => {
  return (
    <div className="relative w-full">
      <input
        type={type}
        id={id}
        defaultValue={defaultValue}
        required={required}
        placeholder=" " // Required for the peer-placeholder-shown hack
        className="peer block w-full appearance-none rounded-[4px] border border-zinc-500 bg-transparent px-4 pb-2.5 pt-3 text-base text-zinc-100 focus:border-[#E8F582] focus:outline-none focus:ring-1 focus:ring-[#E8F582] transition-all"
      />
      <label
        htmlFor={id}
        className="absolute left-3 top-0 z-10 origin-[0] -translate-y-1/2 scale-75 transform cursor-text select-none bg-[#1E1E1E] px-1 text-sm text-zinc-400 transition-all duration-200 peer-placeholder-shown:top-1/2 peer-placeholder-shown:-translate-y-1/2 peer-placeholder-shown:scale-100 peer-focus:top-0 peer-focus:-translate-y-1/2 peer-focus:scale-75 peer-focus:text-[#E8F582]"
      >
        {label}
      </label>
    </div>
  );
};

const PasswordModal = ({ isOpen, onClose }) => {
  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = 'unset';
    return () => { document.body.style.overflow = 'unset'; }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />
      
      {/* Modal Surface (MD3 Dialog) */}
      <div className="relative z-10 w-full max-w-md transform overflow-hidden rounded-[28px] bg-[#1E1E1E] p-6 text-left align-middle shadow-2xl transition-all">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-normal text-zinc-100">
            Изменение пароля
          </h3>
          <button 
            onClick={onClose}
            className="rounded-full p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); onClose(); }} className="space-y-6">
          <MD3Input label="Старый пароль" type="password" id="old-pwd" required />
          <MD3Input label="Новый пароль" type="password" id="new-pwd" required />
          <MD3Input label="Ещё раз" type="password" id="confirm-pwd" required />
          
          <div className="mt-8 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full px-6 py-2.5 text-sm font-medium text-[#E8F582] hover:bg-[#E8F582]/10 transition-colors"
            >
              Отмена
            </button>
            <button
              type="submit"
              className="rounded-full bg-[#E8F582] px-6 py-2.5 text-sm font-medium text-[#111111] hover:bg-[#d4e16d] transition-colors"
            >
              Сохранить
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default function ProfileSettings() {
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[#111111] text-zinc-100 font-sans selection:bg-[#E8F582]/30">
      
      {/* App Bar (Header) */}
      <header className="sticky top-0 z-40 bg-[#111111]/80 backdrop-blur-md border-b border-zinc-800">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-4 md:px-8">
          <button className="rounded-full p-2 hover:bg-zinc-800 transition-colors">
            <ArrowLeft size={24} className="text-zinc-100" />
          </button>
          <h1 className="text-xl md:text-2xl font-medium">Редактирование профиля</h1>
        </div>
      </header>

      <main className="mx-auto max-w-5xl p-4 py-8 md:px-8">
        {/* CSS Grid for adaptive layout: 1 col on mobile, 2 on lg screens */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-8 lg:items-start">
          
          {}
          <div className="space-y-6 lg:space-y-8">
            
            {/* Card 1: Basic Info */}
            <section className="rounded-[28px] bg-[#1E1E1E] p-6 shadow-sm md:p-8">
              <div className="mb-8 flex flex-col items-center gap-6 sm:flex-row">
                {/* Avatar with edit overlay */}
                <div className="relative group cursor-pointer">
                  <div className="flex h-24 w-24 items-center justify-center rounded-full bg-[#E8F582] text-4xl text-[#111111]">
                    {/* Placeholder Avatar SVG */}
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                    </svg>
                  </div>
                  {/* Edit Icon Overlay */}
                  <div className="absolute bottom-0 right-0 rounded-full border-4 border-[#1E1E1E] bg-zinc-800 p-2 text-zinc-200 transition-transform group-hover:scale-110">
                    <Camera size={16} />
                  </div>
                </div>
                <div className="text-center sm:text-left">
                  <h2 className="text-2xl font-normal text-zinc-100">Юлов Павел</h2>
                  <p className="text-sm text-zinc-400 mt-1">Основная информация</p>
                </div>
              </div>

              <form className="space-y-5 flex flex-col" onSubmit={e => e.preventDefault()}>
                <MD3Input label="Фамилия" id="lastname" defaultValue="Юлов" />
                <MD3Input label="Имя" id="firstname" defaultValue="Павел" />
                <MD3Input label="Отчество" id="middlename" defaultValue="Дмитриевич" />
                
                <button type="submit" className="self-end mt-4 rounded-full bg-[#E8F582] px-8 py-2.5 text-sm font-medium text-[#111111] hover:bg-[#d4e16d] transition-colors">
                  Сохранить
                </button>
              </form>
            </section>

            {}
            {/* Card 2: Security (Extracted from main flow) */}
            <section className="rounded-[28px] bg-[#1E1E1E] p-6 shadow-sm md:p-8">
               <div className="flex items-center gap-4 mb-6">
                 <div className="p-3 bg-zinc-800 rounded-full text-zinc-300">
                    <Shield size={24} />
                 </div>
                 <div>
                    <h2 className="text-xl font-normal text-zinc-100">Безопасность</h2>
                    <p className="text-sm text-zinc-400 mt-1">Управление доступом</p>
                 </div>
               </div>
               <button 
                  onClick={() => setIsPasswordModalOpen(true)}
                  className="w-full rounded-full border border-zinc-600 bg-transparent py-3 text-sm font-medium text-zinc-200 hover:bg-zinc-800 transition-colors focus:ring-2 focus:ring-[#E8F582] outline-none"
                >
                  Изменить пароль
               </button>
            </section>
          </div>

          {}
          <div className="space-y-6 lg:space-y-8">
            
            {/* Card 3: Education Data */}
            <section className="rounded-[28px] bg-[#1E1E1E] p-6 shadow-sm md:p-8">
              <h2 className="text-xl font-normal text-zinc-100 mb-6">Данные об обучении</h2>
              <form className="space-y-5 flex flex-col" onSubmit={e => e.preventDefault()}>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <MD3Input label="Номер группы" id="group" defaultValue="107" />
                  <MD3Input label="Форма обучения" id="edu-form" defaultValue="Бюджет" />
                </div>
                <MD3Input label="Место жительства" id="residence" />
                
                <button type="submit" className="self-end mt-4 rounded-full bg-[#E8F582] px-8 py-2.5 text-sm font-medium text-[#111111] hover:bg-[#d4e16d] transition-colors">
                  Сохранить
                </button>
              </form>
            </section>

            {/* Card 4: Contact Data */}
            <section className="rounded-[28px] bg-[#1E1E1E] p-6 shadow-sm md:p-8">
              <h2 className="text-xl font-normal text-zinc-100 mb-6">Контактные данные</h2>
              <form className="space-y-5 flex flex-col" onSubmit={e => e.preventDefault()}>
                <MD3Input label="Телефон" type="tel" id="phone" defaultValue="+7 912 888 999 000" />
                <MD3Input label="Телеграмм" id="telegram" defaultValue="@pavel_yu" />
                <MD3Input label="Почта" type="email" id="email" defaultValue="pavel.d.yulov@gmail.com" />
                <MD3Input label="ВК (ссылка)" id="vk" />
                
                <button type="submit" className="self-end mt-4 rounded-full bg-[#E8F582] px-8 py-2.5 text-sm font-medium text-[#111111] hover:bg-[#d4e16d] transition-colors">
                  Сохранить
                </button>
              </form>
            </section>

          </div>
        </div>
      </main>

      {}
      <PasswordModal 
        isOpen={isPasswordModalOpen} 
        onClose={() => setIsPasswordModalOpen(false)} 
      />
      
    </div>
  );
}