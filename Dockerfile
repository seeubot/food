# Use an official Node.js runtime as a parent image
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /app

# Install necessary system dependencies for Chromium
# This list is more comprehensive and includes common libraries needed by headless Chrome
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    udev \
    # Additional common dependencies for building and running Node.js apps with native modules
    git \
    openssh-client \
    python3 \
    make \
    g++ \
    dumb-init \
    # More specific dependencies often needed by Chromium
    mesa-gl \
    libstdc++ \
    libgcc \
    libxcomposite \
    libxdamage \
    libxfixes \
    libxrandr \
    libxcursor \
    libxkbcommon \
    libxmu \
    libxpm \
    libxt \
    libxv \
    libxxf86vm \
    alsa-lib \
    dbus \
    glib \
    pango \
    cairo \
    pixman \
    # Ensure fonts are properly configured
    # fc-cache is part of fontconfig and helps rebuild font caches
    && fc-cache -f -v

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
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Run the application
CMD [ "npm", "start" ]

