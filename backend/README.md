# prof_home
## Описание проекта

Backend для профкома на **FastAPI** с использованием **SQLite + SQLAlchemy**.  
Поддерживает работу с пользователями, контактной информацией и гайдами, а также систему прав: **SuperUser**, **Admin**, **обычный пользователь**, **banned**.

Структура пакета: всё находится в папке `prof_back` и запускается как Python‑пакет.

## Установка и запуск

### 1. Клонирование репозитория

```bash
git clone <URL_ТВОЕГО_РЕПОЗИТОРИЯ>.git
cd <имя_папки_репозитория>
```

### 2. Виртуальное окружение и зависимости

```bash
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r prof_back/requirements.txt
```

### 3. Запуск сервера

```bash
uvicorn main:app --reload
```

По умолчанию сервер поднимется на `http://127.0.0.1:8000`.

База данных создаётся автоматически в файле `profcom.db` (SQLite) в корне проекта.

---

## Модель данных

### Таблица `users`

- `user_id` – PK
- `user_name` – отображаемое имя (из ККР)
- `kkr_score` – баллы ККР
- `group_number` – номер группы
- `blocks` – блоки
- `banned` – забанен ли
- `super_user` – является ли председателем
- `admin` – права админа

### Таблица `contact_info`

- `user_id` – PK, FK на `users.user_id`
- `surname` – фамилия
- `name` – имя
- `patronymic` – отчество
- `kkr_name` – имя ККР
- `group_number` – номер группы
- `location` – место проживания
- `blocks` – блоки
- `phone` – телефон
- `vk` – ссылка/ID ВК
- `tg` – ник в Telegram
- `email` – почта
- `budget` – бюджет (`true`) / платка (`false`)
- `in_profcom` – состоит ли в профкоме

### Таблица `guides`

- `guide_id` – PK
- `title` – название гайда
- `owner_block` – блок‑владелец
- `text` – текст гайда
- `description` – краткое описание гайда
- `original_link` – ссылка на оригинал

---

## Авторизация / права

Сейчас авторизация упрощена:  
**кто делает запрос**, определяется query‑параметром `auth_id` (ID пользователя в БД).

- Права SuperUser: `super_user == true`
- Права Admin: `admin == true`
- Для некоторых эндпоинтов достаточно быть Admin **или** SuperUser.

Пример: `DELETE /profile/4?auth_id=5` – пользователь с `user_id=5` пытается удалить пользователя с `user_id=4`.

---

## Эндпоинты

Ниже все основные ручки с входом/выходом.

---

### 1. Регистрация

**POST `/auth/register`**

Создаёт запись в `contact_info` и `users`.

**Тело запроса (JSON):**

```json
{
  "email": "ivan@example.com",
  "surname": "Петров",
  "name": "Иван",
  "patronymic": "Петрович",
  "password": "secret-password",
  "group_number": 101,
  "tg": "@ivan"
}
```

Примечание: поля `kkr_score`, `blocks`, `banned`, `super_user`, `admin` всё равно создаются в БД, но на регистрации выставляются сервером (дефолтами). Пользователь не может выдать себе права через регистрацию.

**Ответ (201, JSON, токены):**

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "bearer"
}
```

---

### 2. Вход (логин)

**POST `/auth/login`**

Поиск пользователя по `email` (из `contact_info`) + проверка пароля.

Пример запроса:

```json
{
  "email": "ivan@example.com",
  "password": "secret-password"
}
```

**Ответ (200, JSON, токены):**

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "bearer"
}
```

Ошибки:
- 401 – если пользователь не найден или пароль неверный.

---

### 3. Страница профиля – получить данные

**GET `/profile/{user_id}`**

Возвращает информацию о пользователе (из таблицы `users`) + `email` и `tg` (из `contact_info`).

**Параметры пути:**

- `user_id` – ID пользователя, чьи данные смотрим.

Пример:

```http
GET /profile/1
```

**Ответ (200, JSON):**

```json
{
  "user_id": 1,
  "user_name": "Иван Петров",
  "kkr_score": 0,
  "group_number": "КН-101",
  "blocks": "КН",
  "banned": false,
  "super_user": false,
  "admin": false,
  "mero_ids": []
}
```

Ошибки:
- 404 – если пользователь не найден.

---

### 3.1. Профиль текущего пользователя (me)

**GET `/profile/me`**

Требует Bearer access token. Возвращает профиль пользователя **вместе с `email` и `tg`** (из `contact_info`).

---

### 4. Страница профиля – обновление данных

**PATCH `/profile/{user_id}`**

Обновляет данные профиля (и в `contact_info`, и часть полей в `users`).  
Разрешено:

- самому пользователю (`auth_id == user_id`),
- любому Admin (`admin == true`),
- SuperUser (`super_user == true`).

**Параметры:**

- Path: `user_id` – кого обновляем.
- Query: `auth_id` – кто делает запрос.

Пример:

```http
PATCH /profile/1?auth_id=1
Content-Type: application/json
```

**Тело (любые поля опциональны):**

```json
{
  "surname": "Петров",
  "name": "Иван",
  "patronymic": "Петрович",
  "group_number": "КН-102",
  "location": "корпус Б",
  "blocks": "КН"
}
```

**Ответ (200, JSON – обновлённый `UserOut`):**

```json
{
  "user_id": 1,
  "user_name": "Иван Петров",
  "kkr_score": 0,
  "group_number": "КН-102",
  "blocks": "КН",
  "banned": false,
  "super_user": false,
  "admin": false,
  "mero_ids": []
}
```

Ошибки:
- 404 – пользователь не найден.
- 403 – нет прав (ни сам, ни admin/super_user).

---

### 5. Удаление пользователя (SuperUser only)

**DELETE `/profile/{user_id}`**

Удаляет пользователя и его `contact_info`.  
Только SuperUser.

**Параметры:**

- Path: `user_id` – кого удаляем.
- Query: `auth_id` – кто делает запрос (должен быть SuperUser).

Пример:

```http
DELETE /profile/4?auth_id=5
```

**Ответ (200, JSON):**

```json
{ "status": "deleted" }
```

Ошибки:
- 404 – пользователь не найден.
- 403 – `auth_id` не SuperUser.

---

### 6. Гайды – список

**GET `/guides`**

Возвращает список всех гайдов.

**Пример запроса:**

```http
GET /guides
```

**Ответ (200, JSON, список `GuideOut`):**

```json
[
  {
    "guide_id": 1,
    "title": "Как вступить в профком",
    "owner_block": "КН",
    "text": "Длинный текст гайда...",
    "description": "Краткое описание гайда...",
    "original_link": "https://example.com/guide1"
  }
]
```

---

### 7. Гайды – создание / редактирование

(Сейчас реализовано только **создание** – каждый POST создаёт новую запись.)

**POST `/guides`**

Доступно Admin и SuperUser.

**Параметры:**

- Query: `auth_id` – ID пользователя, который создаёт (должен иметь `admin == true` или `super_user == true`).

**Тело запроса (JSON, `GuideIn`):**

```json
{
  "title": "Как вступить в профком",
  "owner_block": "КН",
  "text": "Подробный гайд...",
  "description": "Краткое описание гайда...",
  "original_link": "https://example.com/guide1"
}
```

**Ответ (200, JSON, `GuideOut`):**

```json
{
  "guide_id": 1,
  "title": "Как вступить в профком",
  "owner_block": "КН",
  "text": "Подробный гайд...",
  "description": "Краткое описание гайда...",
  "original_link": "https://example.com/guide1"
}
```

Ошибки:
- 403 – если `auth_id` не admin и не super_user.

---

### 8. Контактная информация – весь список

**GET `/contacts`**

Возвращает **всю** таблицу `contact_info`.

**Пример:**

```http
GET /contacts
```

**Ответ (200, JSON, список `ContactInfoOut`):**

```json
[
  {
    "user_id": 1,
    "surname": "Петров",
    "name": "Иван",
    "patronymic": "",
    "kkr_name": "IvanP",
    "group_number": "КН-101",
    "location": "корпус А",
    "blocks": "КН",
    "phone": "+79991234567",
    "vk": "id123",
    "tg": "@ivan",
    "email": "ivan@example.com",
    "budget": true,
    "in_profcom": false
  }
]
```

---

### 9. Контактная информация – фильтрация (для админа)

**POST `/contacts/filter`**

Доступно Admin и SuperUser.

**Параметры:**

- Query: `auth_id` – кто делает запрос (admin/super_user).

**Тело (JSON, все поля опциональны):**

```json
{
  "group_number": "КН-101",
  "blocks": "КН",
  "in_profcom": true,
  "budget": true
}
```

Фильтрация происходит по равенству полей (если поле передано в запросе).

**Ответ (200, JSON, список `ContactInfoOut`):**

```json
[
  {
    "user_id": 2,
    "surname": "Сидоров",
    "name": "Пётр",
    "patronymic": "",
    "kkr_name": "Petya",
    "group_number": "КН-101",
    "location": "корпус Б",
    "blocks": "КН",
    "phone": "+79990000000",
    "vk": "id555",
    "tg": "@petya",
    "email": "petya@example.com",
    "budget": true,
    "in_profcom": true
  }
]
```

Ошибки:
- 403 – если `auth_id` не admin и не super_user.

---

Если захочешь, можно в README дополнительно описать:
- схему прав доступа (кто что видит/может править),
- пример последовательности запросов (регистрация → логин → обновление профиля → фильтрация контактов).
