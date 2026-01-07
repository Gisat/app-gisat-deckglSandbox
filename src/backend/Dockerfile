FROM python:3.10-slim
WORKDIR /app
RUN mkdir -p /app/data
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
COPY wsgi.py ./wsgi.py
CMD ["gunicorn", "wsgi:application", "-b", "0.0.0.0:5000"]
