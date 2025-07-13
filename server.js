// server.js
const express = require('express');
const mongoose = require('mongoose');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');
const dotenv = require('dotenv');
const cron = require('node-cron');
const bcrypt = require('bcrypt');
const session = require('express-session');

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
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER || 'YOUR_ADMIN_PHONE_NUMBER_HERE'; // e.g., '1234567890@c.us' for WhatsApp, or just '1234567890' for SMS concept

// MongoDB Models
const Product = require('./models/Product');
const Order = require('./models/Order');

// Middleware
app.use(express.json()); // For parsing application/json
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' directory

// Session middleware for basic authentication
app.use(session({
    secret: process.env.SESSION_SECRET || 'supersecretkey',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Basic Authentication Middleware
const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/admin/login');
};

// --- MongoDB Connection ---
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- WhatsApp Bot Initialization ---
let whatsappClient;
let qrCodeData = 'Loading QR Code...'; // To store QR code data for display on dashboard

const initializeWhatsAppClient = async () => { // Made this function async
    whatsappClient = new Client({
        authStrategy: new LocalAuth(), // Stores session data locally
        puppeteer: {
            // Docker-optimized arguments for running headless Chromium
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage', // Critical for Docker to prevent shared memory issues
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
                '--single-process', // Can help with memory usage in Docker
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
            timeout: 120000, // Increased timeout to 120 seconds
            // Explicitly handle Chrome executable path for Docker
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            ignoreDefaultArgs: ['--disable-extensions'],
            defaultViewport: null,
            ignoreHTTPSErrors: true
        }
    });

    whatsappClient.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        qrCodeData = qr; // Store QR data to display on dashboard
        console.log('QR RECEIVED', qr);
    });

    whatsappClient.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        qrCodeData = 'WhatsApp Client is ready!'; // Update status on dashboard
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
        // Add more bot logic here for direct WhatsApp orders or queries
    });

    whatsappClient.on('disconnected', (reason) => {
        console.log('WhatsApp Client was disconnected', reason);
        qrCodeData = `Disconnected: ${reason}. Please refresh to get new QR.`;
        // Attempt to re-initialize after a delay or on user action
        // For production, consider a more robust re-initialization strategy
        // setTimeout(() => initializeWhatsAppClient(), 5000);
    });

    // Add a general error listener for the client
    whatsappClient.on('error', (error) => {
        console.error('WhatsApp Client Error:', error);
        qrCodeData = `Error: ${error.message}. Please check logs.`;
    });

    try {
        console.log('Initializing WhatsApp Client...');
        
        // Add a small delay before initialization to ensure system is ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('Starting WhatsApp client initialization...');
        await whatsappClient.initialize();
        console.log('WhatsApp Client initialization complete.');
    } catch (error) {
        console.error('Failed to initialize WhatsApp Client:', error);
        qrCodeData = `Initialization failed: ${error.message}. Check Docker logs for details.`;
        
        // Retry mechanism with exponential backoff
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
    res.sendFile(path.join(__dirname, 'public', 'admin-login.html')); // Create a simple login HTML
});

// Admin Login POST
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    // Use hardcoded admin credentials
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

// API to get QR Code for dashboard
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
            // Notify user about status change via WhatsApp
            if (whatsappClient && whatsappClient.isReady) {
                const userNumber = order.userWhatsAppNumber; // Assuming this is stored in the order
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
        res.status(204).send(); // No content
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

        // Validate items and calculate total
        let totalAmount = 0;
        const orderItems = [];
        for (const item of items) {
            const product = await Product.findById(item.productId);
            if (!product) {
                return res.status(400).json({ message: `Product with ID ${item.productId} not found.` });
            }
            // Ensure product.name is available for the admin notification
            orderItems.push({
                product: product._id,
                quantity: item.quantity,
                price: product.price // Store current price at time of order
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
            status: 'Pending' // Initial status
        });

        await newOrder.save();

        // Re-populate product details for the notification message
        await newOrder.populate('items.product');

        // Notify admin via WhatsApp
        if (whatsappClient && whatsappClient.isReady && ADMIN_PHONE_NUMBER) {
            let orderSummary = `*New Order Received!* 🛍️\nOrder ID: #${newOrder._id}\nCustomer: ${userName || 'N/A'}\nWhatsApp: ${userWhatsAppNumber || 'N/A'}\nAddress: ${userAddress || 'N/A'}\nTotal: ₹${totalAmount.toFixed(2)}\nPayment: ${paymentMethod}\n\nItems:\n`;
            newOrder.items.forEach(item => {
                orderSummary += `- ${item.quantity} x ${item.product ? item.product.name : 'Unknown Product'} (₹${item.price.toFixed(2)} each)\n`;
            });
            orderSummary += `\nView dashboard for details: ${process.env.DASHBOARD_URL}`;
            whatsappClient.sendMessage(ADMIN_PHONE_NUMBER, orderSummary);
        }
        // SMS notification concept (requires SMS gateway API)
        // if (SMS_API_ENABLED && ADMIN_SMS_NUMBER) {
        //     sendSMS(ADMIN_SMS_NUMBER, `New order #${newOrder._id} from ${userName}. Total: ₹${totalAmount.toFixed(2)}. Check dashboard.`);
        // }

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });

    } catch (error) {
        console.error('Error placing order:', error);
        res.status(500).json({ message: 'Error placing order' });
    }
});

// --- Scheduled Task: Auto-notify users for orders older than 7 days ---
// This cron job will run once every day at 2 AM (0 2 * * *)
cron.schedule('0 2 * * *', async () => {
    console.log('Running daily cron job to notify users about old orders...');
    try {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Find orders that are 'Completed' and older than 7 days, and haven't been notified recently
        // You might need an additional field in the Order model like `lastNotifiedAt`
        const ordersToNotify = await Order.find({
            status: 'Completed',
            createdAt: { $lte: sevenDaysAgo },
            // Add a check here if you want to prevent repeated notifications for the same order
            // e.g., lastNotifiedAt: { $lt: sevenDaysAgo } or lastNotifiedAt: { $exists: false }
        });

        if (whatsappClient && whatsappClient.isReady) {
            for (const order of ordersToNotify) {
                const userNumber = order.userWhatsAppNumber;
                if (userNumber) {
                    const message = `👋 Hi there! It's been a while since your last order #${order._id} on ${order.createdAt.toDateString()}. We hope you enjoyed your items! Check out our latest menu: ${process.env.WEB_MENU_URL}`;
                    whatsappClient.sendMessage(userNumber, message);
                    console.log(`Notified user ${userNumber} about old order #${order._id}`);
                    // Optionally, update a `lastNotifiedAt` field on the order here
                    // await Order.findByIdAndUpdate(order._id, { lastNotifiedAt: new Date() });
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
    console.log(`Admin dashboard: http://localhost:${PORT}/dashboard (Login at /admin/login)`);
    console.log(`Admin credentials: Username: ${ADMIN_CREDENTIALS.username}, Password: ${ADMIN_CREDENTIALS.password}`);
});
