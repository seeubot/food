# Use Node.js LTS version
FROM node:18-alpine

# Install necessary packages for Puppeteer and media processing
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ffmpeg \
    && rm -rf /var/cache/apk/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Create directory for WhatsApp session
RUN mkdir -p /app/.wwebjs_auth

# Set proper permissions
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Expose port (if needed for webhooks later)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('Bot is running')" || exit 1

# Start the application
CMD ["npm", "start"]
