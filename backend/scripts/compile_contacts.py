import pandas as pd
import os

files = [
    "Профком __ Контактная информация.xlsx - Активисты.csv",
]

lines = []

for f in files:
    if os.path.exists(f):
        df = pd.read_csv(f)
        df.columns = df.columns.str.strip()
        
        for index, row in df.iterrows():
            fio = str(row.get("ФИО", "")).strip()
            if not fio or fio.lower() == "nan": continue
            
            kkr = str(row.get("Имя ККР", "")).strip()
            group = str(row.get("Номер группы", "")).strip()
            living = str(row.get("Место жительства", "")).strip()
            blocks = str(row.get("Блоки", "")).strip()
            phone = str(row.get("Телефон", "")).strip()
            vk = str(row.get("ВК", "")).strip()
            tg = str(row.get("Telegram", "")).strip()
            mail = str(row.get("Почта", "")).strip()
            study = str(row.get("Форма обучения", "")).strip()

            def clean_nan(val):
                return "" if val.lower() == "nan" else val

            # Clean up trailing comma in blocks if it exists
            cleaned_blocks = clean_nan(blocks)
            if cleaned_blocks.endswith(","):
                cleaned_blocks = cleaned_blocks[:-1]

            chip = f"""```
```text?code_stdout&code_event_index=2
Generated file: Contacts_Chips.md

```chip
Имя: {clean_nan(fio)}
ККР: {clean_nan(kkr)}
Группа: {clean_nan(group)}
Место жительства: {clean_nan(living)}
Блоки: {cleaned_blocks}
Телефон: {clean_nan(phone)}
ВК: {clean_nan(vk)}
ТГ: {clean_nan(tg)}
Почта: {clean_nan(mail)}
Форма обучения: {clean_nan(study)}
```"""
            lines.append(chip)

md_content = "\n\n".join(lines)
output_file = "информация.md"
with open(output_file, "w", encoding="utf-8") as out:
    out.write(md_content)

print(f"Generated file: {output_file}")