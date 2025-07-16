# Use Node.js LTS version
FROM node:18-alpine

# Install necessary packages for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ffmpeg

# Set working directory
WORKDIR /app

# Copy everything first (simpler approach)
COPY . .

# Install dependencies
RUN npm install --production

# Debug: List files to make sure index.js is there
RUN ls -la /app/

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Create directory for WhatsApp session
RUN mkdir -p /app/.wwebjs_auth

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
