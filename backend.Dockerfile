FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV HEATMAP_GEOJSON=/app/seattle/data/processed/seattle_heatmap_grid.geojson
ENV HEATMAP_BUILT_MASS=/app/seattle/data/processed/seattle_heatmap_built_mass.json

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/*.py ./backend/
COPY public/seattle/train-service.json ./public/seattle/train-service.json
COPY seattle/data/processed/seattle_heatmap_grid.geojson ./seattle/data/processed/seattle_heatmap_grid.geojson
COPY seattle/data/processed/seattle_heatmap_built_mass.json ./seattle/data/processed/seattle_heatmap_built_mass.json

EXPOSE 8000

CMD ["uvicorn", "backend.server:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
