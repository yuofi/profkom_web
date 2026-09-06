#!/usr/bin/env bash
#
# Запуск тестов бэкенда Профком ВМК.
#
#   ./run_tests.sh                 полный прогон
#   ./run_tests.sh -k guides       только тесты про гайды
#   ./run_tests.sh --live          проверка запущенного сервера (localhost:8000)
#   ./run_tests.sh --live --url https://site.ru --read-only
#   ./run_tests.sh --cov           прогон с отчётом о покрытии
#
# Тесты работают на ВРЕМЕННОЙ базе SQLite и никогда не трогают data/profcom.db.
#
set -euo pipefail

cd "$(dirname "$0")"

VENV=".venv"
PY="$VENV/bin/python"
BOLD=$'\033[1m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'

MODE="unit"
LIVE_ARGS=()
PYTEST_ARGS=()
WITH_COV=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)       MODE="live"; shift ;;
    --url)        LIVE_ARGS+=(--url "$2"); shift 2 ;;
    --email)      LIVE_ARGS+=(--email "$2"); shift 2 ;;
    --password)   LIVE_ARGS+=(--password "$2"); shift 2 ;;
    --read-only)  LIVE_ARGS+=(--read-only); shift ;;
    --insecure)   LIVE_ARGS+=(--insecure); shift ;;
    --cov)        WITH_COV=1; shift ;;
    -h|--help)    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            PYTEST_ARGS+=("$1"); shift ;;
  esac
done

# ── venv ───────────────────────────────────────────────────
if [[ ! -x "$PY" ]]; then
  echo "${YELLOW}venv не найден, создаю $VENV${OFF}"
  python3 -m venv "$VENV"
  "$PY" -m pip install --quiet --upgrade pip
fi

# ── режим live: проверка запущенного сервера ───────────────
if [[ "$MODE" == "live" ]]; then
  echo "${BOLD}Проверка живого сервера${OFF}"
  exec python3 check_live.py ${LIVE_ARGS[@]+"${LIVE_ARGS[@]}"}
fi

# ── зависимости ────────────────────────────────────────────
NEEDED=(pytest httpx)
[[ $WITH_COV -eq 1 ]] && NEEDED+=(pytest-cov)

MISSING=()
for pkg in "${NEEDED[@]}"; do
  "$PY" -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('${pkg//-/_}') else 1)" 2>/dev/null || MISSING+=("$pkg")
done
if ! "$PY" -c "import fastapi" 2>/dev/null; then
  echo "${YELLOW}Ставлю зависимости приложения из requirements.txt${OFF}"
  "$PY" -m pip install --quiet -r requirements.txt
fi
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "${YELLOW}Ставлю тестовые зависимости: ${MISSING[*]}${OFF}"
  "$PY" -m pip install --quiet ${MISSING[@]+"${MISSING[@]}"}
fi

# ── прогон ─────────────────────────────────────────────────
echo "${BOLD}Тесты бэкенда${OFF} $("$PY" -V)"
echo "${YELLOW}база: временный файл в $TMPDIR — data/profcom.db не затрагивается${OFF}"
echo

ARGS=(-p no:cacheprovider)
if [[ $WITH_COV -eq 1 ]]; then
  ARGS+=(--cov=. --cov-report=term-missing:skip-covered
         --cov-report=html:htmlcov
         --cov-config=.coveragerc)
fi
# bash 3.2 под set -u падает на развороте пустого массива — отсюда идиома ${a[@]+"${a[@]}"}
ARGS+=(${PYTEST_ARGS[@]+"${PYTEST_ARGS[@]}"})

set +e
"$PY" -m pytest "${ARGS[@]}"
CODE=$?
set -e

echo
if [[ $CODE -eq 0 ]]; then
  echo "${GREEN}${BOLD}Все тесты прошли.${OFF}"
  [[ $WITH_COV -eq 1 ]] && echo "Отчёт о покрытии: ${BOLD}htmlcov/index.html${OFF}"
else
  echo "${RED}${BOLD}Есть провалившиеся тесты (код $CODE).${OFF}"
fi
exit $CODE
