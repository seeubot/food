# Use a Node.js 18 (LTS) base image
FROM node:18-slim

# Set working directory
WORKDIR /app

# Install necessary system dependencies for Puppeteer (headless Chrome)
# These packages are crucial for Chrome to run correctly in a headless environment.
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-glib-1-2 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxss1 \
    xdg-utils \
    lsb-release \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Install Google Chrome Stable
# This is the browser that Puppeteer will control.
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json (if available)
# This allows Docker to cache the npm install step.
COPY package*.json ./

# Install Node.js dependencies
# Use --omit=dev to avoid installing dev dependencies in production
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Set environment variables for Puppeteer executable path and WhatsApp admin number
# It's highly recommended to manage these via your deployment platform's environment variables
# rather than hardcoding them in the Dockerfile for production.
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome"
# IMPORTANT: Replace with your actual admin WhatsApp number
ENV ADMIN_PHONE_NUMBER="918897350151" 

# Command to run the application
# Use 'node --experimental-modules server.js' for ES module support
CMD ["node", "--experimental-modules", "server.js"]

