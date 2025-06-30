const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Configure multer for image uploads
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
let db;

// Connect to MongoDB
async function connectToMongoDB() {
    try {
        const client = await MongoClient.connect(MONGO_URI);
        console.log('✅ Connected to MongoDB');
        db = client.db('foodiebot');
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        process.exit(1);
    }
}

// Bot state
let botState = {
    qrCode: null,
    isAuthenticated: false,
    connectedSessions: 0,
    status: 'initializing',
    lastActivity: new Date(),
    webhookUrl: process.env.WEBHOOK_URL
};

// User session management
const userSessions = new Map();

// WhatsApp Client with enhanced configuration for production
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.WHATSAPP_SESSION_PATH || './whatsapp-session'
    }),
    puppeteer: { 
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
        ]
    }
});

// Webhook function to notify external services
async function sendWebhook(event, data) {
    if (!process.env.WEBHOOK_URL) return;
    
    try {
        const webhookPayload = {
            event,
            timestamp: new Date().toISOString(),
            data,
            bot_id: 'foodiebot-' + (process.env.NODE_ENV || 'development')
        };

        const response = await fetch(process.env.WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Webhook-Secret': process.env.WEBHOOK_SECRET || '',
                'User-Agent': 'FoodieBot-Webhook/1.0'
            },
            body: JSON.stringify(webhookPayload)
        });

        if (response.ok) {
            console.log(`📡 Webhook sent successfully: ${event}`);
        } else {
            console.warn(`⚠️ Webhook failed: ${response.status} ${response.statusText}`);
        }
    } catch (error) {
        console.error('❌ Webhook error:', error.message);
    }
}

// Enhanced WhatsApp Event Handlers with Webhook Support
client.on('qr', async (qr) => {
    console.log('\n🔄 Generating QR Code...');
    
    try {
        botState.qrCode = await qrcode.toDataURL(qr);
        botState.isAuthenticated = false;
        botState.status = 'waiting_for_scan';
        botState.lastActivity = new Date();
        
        console.log('✅ QR Code generated successfully!');
        console.log('🌐 QR Code available at:', `${process.env.BASE_URL || 'http://localhost:8000'}/qr`);
        
        // Send webhook notification
        await sendWebhook('qr_generated', {
            status: botState.status,
            qr_available: true
        });
        
    } catch (error) {
        console.error('❌ Error generating QR code:', error);
    }
});

client.on('ready', async () => {
    console.log('\n🎉 SUCCESS! WhatsApp bot is ready and connected!');
    console.log('✅ Bot is now active and can receive messages');
    
    botState.isAuthenticated = true;
    botState.connectedSessions = 1;
    botState.qrCode = null;
    botState.status = 'connected';
    botState.lastActivity = new Date();
    
    // Send webhook notification
    await sendWebhook('bot_ready', {
        status: 'connected',
        phone: client.info?.wid?.user || 'unknown',
        name: client.info?.pushname || 'unknown'
    });
});

client.on('authenticated', async () => {
    console.log('🔐 WhatsApp authenticated successfully');
    botState.isAuthenticated = true;
    botState.status = 'authenticated';
    botState.lastActivity = new Date();
    
    await sendWebhook('authenticated', { status: 'authenticated' });
});

client.on('auth_failure', async (msg) => {
    console.error('❌ WhatsApp authentication failed:', msg);
    botState.isAuthenticated = false;
    botState.qrCode = null;
    botState.status = 'auth_failed';
    
    await sendWebhook('auth_failure', { error: msg });
});

client.on('disconnected', async (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
    botState.isAuthenticated = false;
    botState.connectedSessions = 0;
    botState.status = 'disconnected';
    
    await sendWebhook('disconnected', { reason });
});

// Health check endpoint
app.get('/health', (req, res) => {
    const health = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        bot_status: botState.status,
        bot_authenticated: botState.isAuthenticated,
        mongodb_connected: !!db
    };
    
    res.status(200).json(health);
});

// Webhook endpoint for receiving external notifications
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const signature = req.headers['x-webhook-signature'];
    const payload = req.body;
    
    // Verify webhook signature if secret is provided
    if (process.env.WEBHOOK_SECRET && signature) {
        const crypto = require('crypto');
        const expectedSignature = crypto
            .createHmac('sha256', process.env.WEBHOOK_SECRET)
            .update(payload)
            .digest('hex');
        
        if (signature !== `sha256=${expectedSignature}`) {
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }
    
    try {
        const data = JSON.parse(payload);
        console.log('📡 Webhook received:', data);
        
        // Process webhook data here
        // You can trigger bot actions based on external events
        
        res.status(200).json({ success: true, received: true });
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        res.status(400).json({ error: 'Invalid JSON payload' });
    }
});

// Enhanced API Routes with better error handling
app.get('/api/status', (req, res) => {
    res.json({
        ...botState,
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development',
        version: '1.0.0'
    });
});

// [Include all other existing routes from your original code here]
// ... (menu routes, order routes, user routes, etc.)

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File size too large' });
        }
    }
    
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Initialize the application
async function initializeApp() {
    try {
        console.log('🚀 Starting FoodieBot for Koyeb deployment...');
        
        // Connect to MongoDB first
        await connectToMongoDB();
        
        // Start the Express server
        const PORT = process.env.PORT || 8000;
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log('\n' + '='.repeat(60));
            console.log('🎉 FoodieBot Server Started Successfully!');
            console.log('='.repeat(60));
            console.log(`🌐 Server running on: http://0.0.0.0:${PORT}`);
            console.log(`🌍 Public URL: ${process.env.BASE_URL || 'Not set'}`);
            console.log(`📋 Admin Panel: ${process.env.BASE_URL || 'http://localhost:8000'}`);
            console.log(`🛒 Order Interface: ${process.env.BASE_URL || 'http://localhost:8000'}/order`);
            console.log(`📱 QR Code Page: ${process.env.BASE_URL || 'http://localhost:8000'}/qr`);
            console.log(`💚 Health Check: ${process.env.BASE_URL || 'http://localhost:8000'}/health`);
            console.log('='.repeat(60));
            console.log('\n⏳ Initializing WhatsApp client...');
        });
        
        // Graceful shutdown handler
        process.on('SIGTERM', () => {
            console.log('📱 Received SIGTERM, shutting down gracefully...');
            server.close(async () => {
                try {
                    await client.destroy();
                    console.log('✅ Server closed successfully');
                    process.exit(0);
                } catch (error) {
                    console.error('❌ Error during shutdown:', error);
                    process.exit(1);
                }
            });
        });
        
        // Initialize WhatsApp client
        console.log('🔄 Starting WhatsApp client initialization...');
        await client.initialize();
        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        process.exit(1);
    }
}

// Start the application
initializeApp();
