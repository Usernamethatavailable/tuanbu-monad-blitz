FROM python:3.12-slim

WORKDIR /app
COPY requirements-chain.txt .
RUN python -m pip install --no-cache-dir -r requirements-chain.txt \
    && install -d -o 10001 -g 10001 /data
COPY ["原型/", "原型/"]

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TUANBU_DB=/data/tuanbu.sqlite3
USER 10001:10001
EXPOSE 8422
CMD ["python", "原型/preview_server.py"]
