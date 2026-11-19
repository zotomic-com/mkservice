# own downloader — public API container (Railway / Render / Fly.io)
# Includes Python + yt-dlp (engine), ffmpeg (merging/MP3), Node.js (server),
# and the bgutil PO-token provider (helps with YouTube datacenter bot checks)

FROM python:3.12-slim

# git is needed to clone the PO-token provider; Node 22 required by it
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates git fonts-dejavu-core poppler-utils zip && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# LibreOffice powers Documents → PDF. It is optional: if the install fails the
# rest of the converter still deploys and that one sub-service reports a
# friendly error instead of breaking the whole build.
RUN apt-get update && \
    (apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress || true) && \
    rm -rf /var/lib/apt/lists/*

# Download engine + text-to-speech + yt-dlp PO-token plugin (bgutil)
# yt-dlp[default] includes the yt-dlp-ejs challenge solver scripts
# img2pdf powers the Images → PDF converter
RUN pip install --no-cache-dir -U "yt-dlp[default]" edge-tts bgutil-ytdlp-pot-provider img2pdf

# Document + image helpers used by the extra converter sub-services.
RUN pip install --no-cache-dir pillow pymupdf openpyxl python-pptx python-docx

# AI background removal is optional (model download happens on first use).
RUN pip install --no-cache-dir rembg onnxruntime || true

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
