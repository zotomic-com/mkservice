# own downloader — public API container (Railway / Render / Fly.io)
# Includes Python + yt-dlp (engine), ffmpeg (merging/MP3), Node.js (server)

FROM python:3.12-slim

# Node.js + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Download engine + text-to-speech
RUN pip install --no-cache-dir -U yt-dlp edge-tts

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV MODE=public
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
