FROM python:3.12-slim

RUN groupadd -r profkom && useradd -r -g profkom -m admin
WORKDIR /app
RUN mkdir /app/data

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

RUN chown -R admin:profkom /app
USER admin
EXPOSE 8000

RUN chmod +x ./entrypoint.sh
ENTRYPOINT [ "./entrypoint.sh" ]