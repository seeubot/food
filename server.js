// server.js
const express = require('express');
const mongoose = require('mongoose');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // Add this dependency for QR generation
const path = require('path');
const dotenv = require('dotenv');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const session = require('express-session');
const rateLimit = require('express-rate-limit'); // Add this dependency for rate limiting

// Load environment variables from .env file
dotenv.config();

// Hardcoded admin credentials
const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: 'admin123'
};

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || 'YOUR_ADMIN_PHONE_NUMBER_HERE';

// QR Code storage and management
let whatsappQRData = null;
let qrCodeGeneratedAt = null;
let qrCodeAccessToken = null;
const QR_EXPIRY_TIME = 5 * 60 * 1000; // 5 minutes

// MongoDB Models
const Product = require('./models/Product');
const Order = require('./models/Order');

// Rate limiting for QR endpoints
const qrRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // limit each IP to 10 requests per windowMs
    message: 'Too many QR requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session middleware for basic authentication
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretkey',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Basic Authentication Middleware
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
    
    // Check if QR code is still valid
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
    return require('crypto').randomBytes(32).toString('hex');
};

// --- MongoDB Connection ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- WhatsApp Bot Initialization ---
let whatsappClient;
let qrCodeData = 'Loading QR Code...';

const initializeWhatsAppClient = async () => {
    whatsappClient = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-plugins',
                '--disable-images',
                '--disable-javascript',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--disable-web-security',
                '--disable-features=site-per-process',
                '--disable-site-isolation-trials',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--no-default-browser-check',
                '--no-zygote',
                '--single-process',
                '--memory-pressure-off',
                '--max_old_space_size=4096',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--metrics-recording-only',
                '--no-crash-upload',
                '--disable-component-update'
            ],
            timeout: 120000,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            ignoreDefaultArgs: ['--disable-extensions'],
            defaultViewport: null,
            ignoreHTTPSErrors: true
        }
    });

    whatsappClient.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        qrCodeData = qr;
        whatsappQRData = qr;
        qrCodeGeneratedAt = Date.now();
        qrCodeAccessToken = generateQRAccessToken();
        console.log('QR RECEIVED', qr);
        console.log('QR Access Token:', qrCodeAccessToken);
    });

    whatsappClient.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        qrCodeData = 'WhatsApp Client is ready!';
        whatsappQRData = null; // Clear QR data when connected
        qrCodeAccessToken = null;
    });

    whatsappClient.on('message', async msg => {
        console.log('MESSAGE RECEIVED', msg.body);
        const userMessage = msg.body.toLowerCase();

        if (userMessage === '!ping') {
            msg.reply('pong');
        } else if (userMessage.includes('hi') || userMessage.includes('hello')) {
            msg.reply('👋 Hello there! How can I assist you today? You can view our menu or place an order.');
        } else if (userMessage.includes('menu')) {
            msg.reply(`Here's our delicious menu: ${process.env.WEB_MENU_URL} 🍽️`);
        } else if (userMessage.includes('order')) {
            msg.reply(`Ready to order? Visit our web menu here: ${process.env.WEB_MENU_URL} 🛒`);
        } else if (userMessage.includes('help')) {
            msg.reply('I can help you with placing an order! Just say "menu" to see what\'s available, or visit our website directly.');
        }
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('WhatsApp Client was disconnected', reason);
        qrCodeData = `Disconnected: ${reason}. Please refresh to get new QR.`;
        whatsappQRData = null;
        qrCodeAccessToken = null;
    });

    whatsappClient.on('error', (error) => {
        console.error('WhatsApp Client Error:', error);
        qrCodeData = `Error: ${error.message}. Please check logs.`;
        whatsappQRData = null;
        qrCodeAccessToken = null;
    });

    try {
        console.log('Initializing WhatsApp Client...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('Starting WhatsApp client initialization...');
        await whatsappClient.initialize();
        console.log('WhatsApp Client initialization complete.');
    } catch (error) {
        console.error('Failed to initialize WhatsApp Client:', error);
        qrCodeData = `Initialization failed: ${error.message}. Check Docker logs for details.`;
        whatsappQRData = null;
        qrCodeAccessToken = null;
        
        console.log('Attempting to restart WhatsApp client in 10 seconds...');
        setTimeout(() => {
            console.log('Retrying WhatsApp client initialization...');
            initializeWhatsAppClient();
        }, 10000);
    }
};

// Call the async initialization function
initializeWhatsAppClient();

// --- Routes ---

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
    req.session.destroy(() => {
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
        isConnected: whatsappClient && whatsappClient.isReady,
        accessToken: qrCodeAccessToken,
        expiresAt: qrCodeGeneratedAt ? qrCodeGeneratedAt + QR_EXPIRY_TIME : null,
        timeRemaining: qrCodeGeneratedAt && !isExpired ? QR_EXPIRY_TIME - (now - qrCodeGeneratedAt) : 0
    });
});

// Protected QR Code endpoint with rate limiting
app.get('/api/qr-code', qrRateLimit, validateQRAccess, async (req, res) => {
    try {
        if (!whatsappQRData) {
            return res.status(404).json({ 
                success: false, 
                message: 'QR code not available' 
            });
        }

        const format = req.query.format || 'png';
        const size = parseInt(req.query.size) || 256;

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

// Force QR refresh endpoint (protected)
app.post('/api/qr-refresh', isAuthenticated, async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        
        // Reset QR data
        whatsappQRData = null;
        qrCodeGeneratedAt = null;
        qrCodeAccessToken = null;
        qrCodeData = 'Refreshing QR Code...';
        
        // Reinitialize client
        setTimeout(() => {
            initializeWhatsAppClient();
        }, 2000);
        
        res.json({ 
            success: true, 
            message: 'QR refresh initiated' 
        });
    } catch (error) {
        console.error('Error refreshing QR:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error refreshing QR code' 
        });
    }
});

// Original dashboard QR endpoint (for backward compatibility)
app.get('/api/whatsapp-qr', isAuthenticated, (req, res) => {
    res.json({ qrCode: qrCodeData });
});

// API to get orders for dashboard
app.get('/api/orders', isAuthenticated, async (req, res) => {
    try {
        const orders = await Order.find().populate('items.product').sort({ createdAt: -1 });
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ message: 'Error fetching orders' });
    }
});

// API to update order status
app.post('/api/orders/:id/status', isAuthenticated, async (req, res) => {
    try {
        const { status } = req.body;
        const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (order) {
            if (whatsappClient && whatsappClient.isReady) {
                const userNumber = order.userWhatsAppNumber;
                if (userNumber) {
                    whatsappClient.sendMessage(userNumber, `Your order #${order._id} status has been updated to: *${status}*`);
                }
            }
            res.json(order);
        } else {
            res.status(404).json({ message: 'Order not found' });
        }
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ message: 'Error updating order status' });
    }
});

// API to get menu items for dashboard (and for public order page)
app.get('/api/menu', async (req, res) => {
    try {
        const products = await Product.find();
        res.json(products);
    } catch (error) {
        console.error('Error fetching menu:', error);
        res.status(500).json({ message: 'Error fetching menu' });
    }
});

// API to add/update menu item (admin only)
app.post('/api/menu', isAuthenticated, async (req, res) => {
    try {
        const { name, description, price, imageUrl } = req.body;
        const product = new Product({ name, description, price, imageUrl });
        await product.save();
        res.status(201).json(product);
    } catch (error) {
        console.error('Error adding product:', error);
        res.status(500).json({ message: 'Error adding product' });
    }
});

// API to delete menu item (admin only)
app.delete('/api/menu/:id', isAuthenticated, async (req, res) => {
    try {
        await Product.findByIdAndDelete(req.params.id);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ message: 'Error deleting product' });
    }
});

// Public Order Page
app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// API to place a new order
app.post('/api/order', async (req, res) => {
    try {
        const { items, userWhatsAppNumber, userName, userAddress, paymentMethod } = req.body;

        if (!items || items.length === 0) {
            return res.status(400).json({ message: 'Order must contain items.' });
        }

        let totalAmount = 0;
        const orderItems = [];
        for (const item of items) {
            const product = await Product.findById(item.productId);
            if (!product) {
                return res.status(400).json({ message: `Product with ID ${item.productId} not found.` });
            }
            orderItems.push({
                product: product._id,
                quantity: item.quantity,
                price: product.price
            });
            totalAmount += product.price * item.quantity;
        }

        const newOrder = new Order({
            items: orderItems,
            userWhatsAppNumber,
            userName,
            userAddress,
            totalAmount,
            paymentMethod,
            status: 'Pending'
        });

        await newOrder.save();
        await newOrder.populate('items.product');

        if (whatsappClient && whatsappClient.isReady && ADMIN_PHONE_NUMBER) {
            let orderSummary = `*New Order Received!* 🛍️\nOrder ID: #${newOrder._id}\nCustomer: ${userName || 'N/A'}\nWhatsApp: ${userWhatsAppNumber || 'N/A'}\nAddress: ${userAddress || 'N/A'}\nTotal: ₹${totalAmount.toFixed(2)}\nPayment: ${paymentMethod}\n\nItems:\n`;
            newOrder.items.forEach(item => {
                orderSummary += `- ${item.quantity} x ${item.product ? item.product.name : 'Unknown Product'} (₹${item.price.toFixed(2)} each)\n`;
            });
            orderSummary += `\nView dashboard for details: ${process.env.DASHBOARD_URL}`;
            whatsappClient.sendMessage(ADMIN_PHONE_NUMBER, orderSummary);
        }

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });

    } catch (error) {
        console.error('Error placing order:', error);
        res.status(500).json({ message: 'Error placing order' });
    }
});

// --- Scheduled Task ---
cron.schedule('0 2 * * *', async () => {
    console.log('Running daily cron job to notify users about old orders...');
    try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const ordersToNotify = await Order.find({
            status: 'Completed',
            createdAt: { $lte: sevenDaysAgo }
        });

        if (whatsappClient && whatsappClient.isReady) {
            for (const order of ordersToNotify) {
                const userNumber = order.userWhatsAppNumber;
                if (userNumber) {
                    const message = `👋 Hi there! It's been a while since your last order #${order._id} on ${order.createdAt.toDateString()}. We hope you enjoyed your items! Check out our latest menu: ${process.env.WEB_MENU_URL}`;
                    whatsappClient.sendMessage(userNumber, message);
                    console.log(`Notified user ${userNumber} about old order #${order._id}`);
                }
            }
        } else {
            console.log('WhatsApp client not ready for cron job notifications.');
        }
    } catch (error) {
        console.error('Error in cron job:', error);
    }
});

// Redirect root to order page
app.get('/', (req, res) => {
    res.redirect('/order');
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Order page: http://localhost:${PORT}/order`);
    console.log(`Admin dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`QR Panel: http://localhost:${PORT}/qr-panel`);
    console.log(`Admin credentials: Username: ${ADMIN_CREDENTIALS.username}, Password: ${ADMIN_CREDENTIALS.password}`);
});
