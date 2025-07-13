# Use a Debian-based Node.js runtime as a parent image
FROM node:20-slim

# Set the working directory in the container
WORKDIR /app

# Install necessary system dependencies for Chromium
# These are fewer compared to Alpine because 'slim' images are more complete
RUN apt-get update && apt-get install -y \
    chromium \
    # Common dependencies for headless Chrome on Debian-based systems
    # Most of these are likely already present or pulled by 'chromium' package
    libnss3 \
    libfontconfig1 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm-dev \
    libgbm-dev \
    libgconf-2-4 \
    libgtk-3-0 \
    libxkbcommon-x11-0 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    # For building native Node.js modules if any
    build-essential \
    git \
    python3 \
    # For proper signal handling (good practice)
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set dumb-init as the entrypoint to handle signals correctly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Install app dependencies
# A wildcard is used to ensure both package.json and package-lock.json are copied
COPY package*.json ./

# IMPORTANT: Clean previous whatsapp-web.js session data before npm install
# This helps prevent issues if the session data gets corrupted or becomes incompatible
RUN rm -rf .wwebjs_auth

# Install dependencies
# Set PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true because we are installing chromium system-wide
# Set PUPPETEER_EXECUTABLE_PATH to use the system-installed chromium
# On Debian, chromium is often at /usr/bin/chromium or /usr/bin/google-chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Run the application
CMD [ "npm", "start" ]

