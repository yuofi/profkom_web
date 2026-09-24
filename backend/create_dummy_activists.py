import urllib.request
import json

API_URL = "http://127.0.0.1:8000/api/auth/register"

dummy_data = [
    {"name": "Иван", "surname": "Иванов", "patronymic": "Иванович", "email": "ivan@example.com"},
    {"name": "Мария", "surname": "Смирнова", "patronymic": "Александровна", "email": "maria@example.com"},
    {"name": "Алексей", "surname": "Кузнецов", "patronymic": "Дмитриевич", "email": "alexey@example.com"},
    {"name": "Екатерина", "surname": "Попова", "patronymic": "Сергеевна", "email": "ekaterina@example.com"},
    {"name": "Дмитрий", "surname": "Соколов", "patronymic": "Михайлович", "email": "dmitry@example.com"},
    {"name": "Анна", "surname": "Лебедева", "patronymic": "Андреевна", "email": "anna@example.com"},
    {"name": "Максим", "surname": "Козлов", "patronymic": "Владимирович", "email": "maxim@example.com"},
    {"name": "Ольга", "surname": "Новикова", "patronymic": "Игоревна", "email": "olga@example.com"},
    {"name": "Сергей", "surname": "Морозов", "patronymic": "Николаевич", "email": "sergey@example.com"},
    {"name": "Елена", "surname": "Волкова", "patronymic": "Алексеевна", "email": "elena@example.com"},
]

for i, person in enumerate(dummy_data):
    payload = {
        "name": person["name"],
        "surname": person["surname"],
        "patronymic": person["patronymic"],
        "password": "password123",
        "group_number": 101 + i,
        "tg": f"@dummy_tg_{i}",
        "email": person["email"],
        "blocks": "СМИ",
        "banned": False,
        "super_user": False,
        "admin": False
    }
    
    req = urllib.request.Request(API_URL, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as response:
            print(f"Registered {person['name']} {person['surname']}")
    except urllib.error.HTTPError as e:
        print(f"Failed to register {person['name']}: {e.read().decode('utf-8')}")

