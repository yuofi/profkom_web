Для текста используйте Markdown. Для плашек, кнопок и колонок — меню **«Вставить»** в сохранённом гайде блока.

## Текст: шпаргалка Markdown

| Запишите | Получится |
| --- | --- |
| `**важно**` | **важно** |
| `*термин*` | *термин* |
| `~~старое~~` | ~~старое~~ |
| `` `код` `` | `код` |
| `- пункт` | Список с маркером |
| `1. действие` | Нумерованный список |
| `- [ ] проверить` | Пустая отметка; `[x]` — заполненная |
| `> пояснение` | Блок цитаты |

**Чек-лист в гайде не интерактивный:** читатель не может отмечать свой прогресс. Между абзацами оставляйте пустую строку. Чтобы показать символ без форматирования, поставьте перед ним `\`: например, `\*`.

Простая таблица:

```markdown
| Формат | Когда использовать |
| --- | --- |
| PNG | Скриншот |
| JPEG | Фотография |
```

## Заголовки, ссылки и картинки

- **Раздел:** `## Подготовка`. Подраздел: `### Файлы`. По ним сайт сам строит оглавление.
- **Ссылка:** `[Открыть трекер](/tasks)`. Для внешнего сайта используйте полный HTTPS-адрес.
- **Переход внутри гайда:** `[К первому разделу](#section-1)`. Номера идут по порядку Markdown-заголовков, включая подразделы. После перестановки проверьте ссылки.
- **Картинка:** загрузите файл в этот гайд и вставьте его через редактор. Пример записи: `![Описание картинки](file:file-example)` — вымышленный ID замените ссылкой своего файла.

Кнопка-ссылка может вести на другой гайд или раздел текущего; адрес проще выбрать в конструкторе. Закрытый материал останется закрытым для человека без доступа.

```profkom-html id=embed-format-extra-markdown
<details class="guide-card guide-tone-neutral guide-compact">
<summary>Ещё Markdown: код, формулы и галерея</summary>
<p><strong>Код:</strong> обрамите фрагмент тремя обратными кавычками и укажите язык, например json или html. Чтобы показать пример с тройными кавычками внутри, используйте четыре снаружи.</p>
<p><strong>Формулы:</strong> <code>$a^2 + b^2$</code> — внутри строки, пара <code>$$</code> — отдельный блок.</p>
<p><strong>Галерея:</strong> каждый файл — с новой строки. Вместо примерных ID подставьте файлы этого гайда.</p>
<pre><code>&#96;&#96;&#96;gallery
file:file-first | Первый экран
file:file-second | Второй экран
&#96;&#96;&#96;</code></pre>
</details>
```

## Как включить оформленные вставки

В сохранённом **«Гайде блока»** нажмите **«Вставить»**, выберите тип и отметьте **«Включить оформленные вставки в этом гайде»**. Конструктор подготовит разметку; вручную писать её необязательно.

```profkom-html id=embed-format-basics
<section class="guide-card guide-tone-warning guide-compact">
<p><strong>Markdown внутри HTML не работает.</strong> Вместо <code>**важно**</code> пишите <code>&lt;strong&gt;важно&lt;/strong&gt;</code>. Обычный блок <code>html</code> показывает исходный код, а не готовую вставку.</p>
</section>
```

В исходнике оформленный блок окружён строками `` ```profkom-html id=… `` и `` ``` ``. Конструктор создаёт ID автоматически. Если копируете целый блок вручную, задайте ему уникальный ID: строчная латинская буква в начале, затем буквы, цифры и дефисы; до 64 символов.

HTML задаёт структуру: `<p>` — абзац, `<strong>` — выделение, `<a>` — ссылка. Текст пишется между открывающим и закрывающим тегами. Атрибут `class` выбирает оформление, `href` — адрес перехода. В примерах ниже можно заменить текст и ссылку, оставив остальную запись как есть.

## Три готовых примера

Код из раскрывающихся блоков вставляйте в **«Вставить → HTML»**.

```profkom-html id=embed-format-card-example
<section class="guide-card guide-gradient-info guide-compact">
<p><strong>Перед отправкой</strong></p><p>Проверьте дату и место встречи.</p>
</section>
<details class="guide-card guide-tone-neutral guide-compact">
<summary>Код плашки</summary>
<pre><code>&lt;section class="guide-card guide-gradient-info guide-compact"&gt;
  &lt;p&gt;&lt;strong&gt;Перед отправкой&lt;/strong&gt;&lt;/p&gt;
  &lt;p&gt;Проверьте дату и место встречи.&lt;/p&gt;
&lt;/section&gt;</code></pre>
</details>
```

```profkom-html id=embed-format-link-example
<section class="guide-card guide-tone-neutral guide-compact">
<p><strong>Результат: кнопка-ссылка</strong></p>
<p><a class="guide-button" href="/tasks">Открыть трекер</a></p>
</section>
<details class="guide-card guide-tone-neutral guide-compact">
<summary>Код кнопки</summary>
<pre><code>&lt;a class="guide-button" href="/tasks"&gt;
  Открыть трекер
&lt;/a&gt;</code></pre>
</details>
```

```profkom-html id=embed-format-details-example
<details class="guide-card guide-tone-neutral guide-compact">
<summary>Когда нужен исходник?</summary>
<p>Когда макет будут редактировать.</p>
</details>
<details class="guide-card guide-tone-neutral guide-compact">
<summary>Код раскрывающегося ответа</summary>
<pre><code>&lt;details class="guide-card guide-tone-neutral guide-compact"&gt;
  &lt;summary&gt;Когда нужен исходник?&lt;/summary&gt;
  &lt;p&gt;Когда макет будут редактировать.&lt;/p&gt;
&lt;/details&gt;</code></pre>
</details>
```

## Что поддерживается

| Оформление | Как добавить |
| --- | --- |
| Цвет плашки | `guide-tone-neutral`, `guide-tone-info`, `guide-tone-success`, `guide-tone-warning` |
| Градиент | `guide-gradient-info`, `guide-gradient-success`, `guide-gradient-warning` |
| Компактные отступы | `guide-compact` |
| Две или три колонки | Обёртка `guide-grid-2` или `guide-grid-3`; на телефоне станет одна колонка |
| Таблица, картинка, шаги | Готовые формы в **«Вставить»** |

```profkom-html id=embed-format-limits
<div class="guide-grid-2">
<section class="guide-card guide-tone-success guide-compact"><p><strong>Можно</strong></p><p>Текст, списки, таблицы, готовые цветовые темы, ссылки, PNG/JPEG/WebP этого гайда.</p></section>
<section class="guide-card guide-tone-warning guide-compact"><p><strong>Нельзя</strong></p><p>JavaScript, iframe, формы, произвольный CSS, внешние картинки, SVG и встраивание видеоплеера.</p></section>
</div>
```

## Если проверка показывает ошибку

Найдите указанную строку, исправьте её и повторите предпросмотр. Ошибку можно сохранить в черновике; опубликовать такой текст нельзя.

```profkom-html id=embed-format-errors
<details class="guide-card guide-tone-neutral">
<summary>Частые причины и ограничения</summary>
<ul>
<li><strong>Картинка:</strong> нужен файл текущего гайда, описание alt и размеры width/height от 1 до 4096.</li>
<li><strong>Таблица:</strong> обязательно название в caption.</li>
<li><strong>Ссылка:</strong> допустимы HTTPS, путь сайта или существующий якорь. Не добавляйте javascript:, служебные API и собственный атрибут id.</li>
<li><strong>Размер:</strong> до 20 вставок; одна — до 32 КиБ, всего HTML — до 128 КиБ. Разбейте слишком большой блок.</li>
<li><strong>Код:</strong> закрывайте парные теги. Для буквальных &lt; и &gt; используйте &amp;lt; и &amp;gt;.</li>
</ul>
</details>
```

Перед публикацией проверьте вид на телефоне и переходы по ссылкам. Порядок сохранения и публикации — в [гайде для авторов](GUIDE_AUTHORING).
