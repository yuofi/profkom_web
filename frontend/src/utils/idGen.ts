export const generateSlug = (text: string) => {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[*_~`]/g, '')
    .replace(/[^\wа-яё-]/g, '');
};


export const extractToc = (markdown: string) => {
  const regex = /^##\s+(.+)$/gm;
  const toc = [];
  let match;

  while ((match = regex.exec(markdown)) !== null) {
    const cleanTitle = match[1].replace(/[*_~`]/g, '').trim();
    
    toc.push({
      id: generateSlug(cleanTitle),
      title: cleanTitle,
      isActive: toc.length === 0,
    });
  }

  return toc;
};