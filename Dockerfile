# own downloader — public API container (Railway / Render / Fly.io)
# Includes Python + yt-dlp (engine), ffmpeg (merging/MP3), Node.js (server),
# and the bgutil PO-token provider (helps with YouTube datacenter bot checks)

FROM python:3.12-slim

# git is needed to clone the PO-token provider; Node 22 required by it
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates git && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Download engine + text-to-speech + yt-dlp PO-token plugin (bgutil)
RUN pip install --no-cache-dir -U yt-dlp edge-tts bgutil-ytdlp-pot-provider

# bgutil provider HTTP server (started by server.js on 127.0.0.1:4416)
RUN git clone --single-branch --depth 1 --branch 2.0.2 \
      https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil && \
    cd /opt/bgutil/server && npm ci && npx tsc

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV MODE=public
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
