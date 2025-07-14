// server.js
import express from 'express';
import mongoose from 'mongoose';
import pkgWhatsappWeb from 'whatsapp-web.js';
const { Client, LocalAuth } = pkgWhatsappWeb;

import pkgQrcodeTerminal from 'qrcode-terminal';
const qrcode = pkgQrcodeTerminal;

import pkgQrcode from 'qrcode';
const QRCode = pkgQrcode;

import path from 'path';
import { fileURLToPath } from 'url';

import pkgDotenv from 'dotenv';
const dotenv = pkgDotenv;
dotenv.config();

import pkgNodeCron from 'node-cron';
const cron = pkgNodeCron;

import pkgExpressSession from 'express-session';
const session = pkgExpressSession;

import pkgExpressRateLimit from 'express-rate-limit';
const rateLimit = pkgExpressRateLimit;

import fs from 'fs/promises';
import crypto from 'crypto';

// Get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: 'admin123'
};

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || 'YOUR_ADMIN_PHONE_NUMBER_HERE';
const WEB_MENU_URL = process.env.WEB_MENU_URL || `http://localhost:${PORT}/order`;
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://localhost:${PORT}/dashboard`;

// QR Code management
let whatsappQRData = null;
let qrCodeGeneratedAt = null;
let qrCodeAccessToken = null;
const QR_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes

// WhatsApp Client Configuration
const MAX_RETRY_ATTEMPTS = 20;
let currentRetryAttempt = 0;
let whatsappClient = null;
let isInitializing = false;

// Session paths
const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session-whatsapp-bot');
const singletonLockPath = path.join(sessionDir, 'SingletonLock');
const sessionStorePath = path.join(sessionDir, 'session.json');

// MongoDB Models
import Product from './models/Product.js';
import Order from './models/Order.js';

// Rate limiting for QR endpoints
const qrRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Too many QR requests, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretkey',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

// Authentication Middleware
const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/admin/login');
};

// QR Access Token Middleware
const validateQRAccess = (req, res, next) => {
    const { token } = req.query;
    
    if (!token || token !== qrCodeAccessToken) {
        return res.status(401).json({ 
            success: false, 
            message: 'Invalid or expired QR access token' 
        });
    }
    
    if (!qrCodeGeneratedAt || Date.now() - qrCodeGeneratedAt > QR_EXPIRY_TIME) {
        return res.status(410).json({ 
            success: false, 
            message: 'QR code has expired' 
        });
    }
    
    next();
};

// Generate secure access token for QR
const generateQRAccessToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

// --- MongoDB Connection ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- WhatsApp Bot Initialization ---
let qrCodeData = 'Initializing WhatsApp Client...';

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

/**
 * Clean up session files before initialization
 */
const cleanupSessionFiles = async () => {
    try {
        // Remove SingletonLock if exists
        try {
            await fs.access(singletonLockPath);
            await fs.unlink(singletonLockPath);
            console.log('SingletonLock removed successfully');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('Could not remove SingletonLock:', err.message);
            }
        }

        // Remove session.json if exists
        try {
            await fs.access(sessionStorePath);
            await fs.unlink(sessionStorePath);
            console.log('Session file removed successfully');
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('Could not remove session file:', err.message);
            }
        }
    } catch (error) {
        console.error('Error cleaning session files:', error);
    }
};

/**
 * Destroy client and retry initialization
 */
const destroyClientAndRetry = async (clearSession = false, reason = 'unknown') => {
    console.log(`Destroying client and retrying due to: ${reason}. Clear session: ${clearSession}`);
    
    if (whatsappClient) {
        try {
            if (whatsappClient.browser) {
                await whatsappClient.destroy();
            }
        } catch (destroyErr) {
            console.error('Error during client destruction:', destroyErr);
        } finally {
            whatsappClient = null;
        }
    }

    if (clearSession) {
        try {
            await cleanupSessionFiles();
        } catch (fsErr) {
            console.error('Error cleaning session:', fsErr);
        }
    }

    // Reset QR data
    whatsappQRData = null;
    qrCodeGeneratedAt = null;
    qrCodeAccessToken = null;
    qrCodeData = `Restarting WhatsApp Client (${reason})...`;

    // Exponential backoff
    const delay = Math.min(30000, 2000 * Math.pow(2, currentRetryAttempt));
    console.log(`Waiting ${delay / 1000} seconds before next attempt`);
    
    isInitializing = false;
    setTimeout(() => {
        initializeWhatsAppClient();
    }, delay);
};

const initializeWhatsAppClient = async () => {
    if (isInitializing) return;
    isInitializing = true;
    currentRetryAttempt++;

    console.log(`Initializing WhatsApp Client (Attempt ${currentRetryAttempt}/${MAX_RETRY_ATTEMPTS})`);
    
    if (currentRetryAttempt > MAX_RETRY_ATTEMPTS) {
        console.error(`Max retry attempts reached. WhatsApp client could not be initialized.`);
        qrCodeData = 'Initialization failed: Max retries reached.';
        isInitializing = false;
        return;
    }

    try {
        // Clean up session files before starting
        await cleanupSessionFiles();

        const puppeteerExecutablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
        console.log(`Using Puppeteer executable path: ${puppeteerExecutablePath}`);

        whatsappClient = new Client({
            authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--no-zygote',
                    '--disable-gpu',
                    '--single-process',
                    '--window-size=1920,1080',
                    '--ignore-certificate-errors'
                ],
                timeout: 180000,
                executablePath: puppeteerExecutablePath,
                defaultViewport: null
            }
        });

        whatsappClient.on('qr', qr => {
            qrcode.generate(qr, { small: true });
            qrCodeData = qr;
            whatsappQRData = qr;
            qrCodeGeneratedAt = Date.now();
            qrCodeAccessToken = generateQRAccessToken();
            console.log('QR RECEIVED. Access Token generated:', qrCodeAccessToken);
            currentRetryAttempt = 0;
        });

        whatsappClient.on('ready', () => {
            console.log('WhatsApp Client is ready and connected!');
            qrCodeData = 'WhatsApp Client is ready!';
            whatsappQRData = null;
            qrCodeAccessToken = null;
            currentRetryAttempt = 0;
            isInitializing = false;
        });

        whatsappClient.on('message', async msg => {
            console.log(`Message from ${msg.from}: ${msg.body}`);
            const userMessage = msg.body.toLowerCase();

            if (userMessage === '!ping') {
                msg.reply('pong');
            } else if (userMessage.includes('hi') || userMessage.includes('hello')) {
                msg.reply('👋 Hello! How can I assist you today?');
            } else if (userMessage.includes('menu')) {
                msg.reply(`Here's our menu: ${WEB_MENU_URL} 🍽️`);
            } else if (userMessage.includes('order')) {
                msg.reply(`Order here: ${WEB_MENU_URL} 🛒`);
            } else if (userMessage.includes('help')) {
                msg.reply('I can help you place orders! Say "menu" or visit our website.');
            }
        });

        whatsappClient.on('disconnected', (reason) => {
            console.warn('WhatsApp Client disconnected:', reason);
            destroyClientAndRetry(false, `disconnected (${reason})`); 
        });

        whatsappClient.on('auth_failure', (msg) => {
            console.error('WhatsApp Authentication Failure:', msg);
            destroyClientAndRetry(true, `auth_failure (${msg})`);
        });

        whatsappClient.on('loading_screen', (percent, message) => {
            console.log(`Loading WhatsApp: ${percent}% - ${message}`);
            qrCodeData = `Loading: ${percent}% - ${message}`;
        });

        await new Promise(resolve => setTimeout(resolve, 3000));
        await whatsappClient.initialize();
        console.log('WhatsApp client initialized');
    } catch (error) {
        console.error(`Failed to initialize WhatsApp Client: ${error}`);
        isInitializing = false;
        destroyClientAndRetry(true, `initialization_failed (${error.message})`);
    }
};

// Initialize WhatsApp client
initializeWhatsAppClient();

// --- Routes ---

// Health check
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Admin Login Page
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

// Admin Login POST
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
        req.session.isAuthenticated = true;
        res.redirect('/dashboard');
    } else {
        res.status(401).send('Invalid credentials');
    }
});

// Admin Logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/admin/login');
    });
});

// Admin Dashboard (protected)
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// QR Panel Page (protected)
app.get('/qr-panel', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qr-panel.html'));
});

// API to get QR Code status and access token (protected)
app.get('/api/qr-status', isAuthenticated, (req, res) => {
    const now = Date.now();
    const isExpired = qrCodeGeneratedAt && (now - qrCodeGeneratedAt > QR_EXPIRY_TIME);
    
    res.json({
        success: true,
        hasQR: !!whatsappQRData && !isExpired,
        isConnected: whatsappClient && whatsappClient.info,
        accessToken: qrCodeAccessToken,
        expiresAt: qrCodeGeneratedAt ? qrCodeGeneratedAt + QR_EXPIRY_TIME : null,
        timeRemaining: qrCodeGeneratedAt && !isExpired ? QR_EXPIRY_TIME - (now - qrCodeGeneratedAt) : 0
    });
});

// QR Code endpoint with rate limiting
app.get('/api/qr-code', qrRateLimit, validateQRAccess, async (req, res) => {
    try {
        if (!whatsappQRData) {
            return res.status(404).json({ 
                success: false, 
                message: 'QR code not available' 
            });
        }

        const format = req.query.format || 'png';
        const size = parseInt(req.query.size) || 300;

        if (format === 'svg') {
            const qrSvg = await QRCode.toString(whatsappQRData, { 
                type: 'svg',
                width: size,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            });
            res.setHeader('Content-Type', 'image/svg+xml');
            res.send(qrSvg);
        } else {
            const qrBuffer = await QRCode.toBuffer(whatsappQRData, {
                type: 'png',
                width: size,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            });
            res.setHeader('Content-Type', 'image/png');
            res.send(qrBuffer);
        }
    } catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error generating QR code' 
        });
    }
});

// Force QR refresh endpoint
app.post('/api/qr-refresh', isAuthenticated, async (req, res) => {
    try {
        currentRetryAttempt = 0;
        await destroyClientAndRetry(true, 'user_initiated_refresh');
        res.json({ 
            success: true, 
            message: 'QR refresh initiated' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: `Error refreshing QR: ${error.message}` 
        });
    }
});

// ... rest of your routes (orders, menu, etc.) remain unchanged ...

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`QR Panel: http://localhost:${PORT}/qr-panel`);
});
