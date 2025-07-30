const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
// Import MongoAuth for storing session in MongoDB
const { Client, LocalAuth, MessageMedia, MongoStore } = require('whatsapp-web.js'); // Note: MongoStore is part of whatsapp-web.js-mongo
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const cron = require('node-cron');
const speakeasy = require('speakeasy');
const fs = require('fs'); // Keep fs for now for initial migration or manual cleanup if needed, but session management will shift
const crypto = require('crypto');
const cors = require('cors');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey_replace_me_in_production';

const DEFAULT_ADMIN_USERNAME = 'dashboard_admin';
const DEFAULT_ADMIN_PASSWORD = 'password123';

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => {
    console.log('MongoDB connected');
    // Seed default menu items after successful connection
    seedMenuItems();
})
.catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas
const ItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    imageUrl: String,
    category: String,
    isAvailable: { type: Boolean, default: true },
    isTrending: { type: Boolean, default: false }
});

const OrderSchema = new mongoose.Schema({
    customOrderId: { type: String, unique: true, sparse: true },
    pinId: { type: String, unique: true, sparse: true },
    customerPhone: { type: String, required: true },
    customerName: String,
    customerLocation: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    items: [{
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
        name: String,
        price: Number,
        quantity: { type: Number, required: true }
    }],
    totalAmount: { type: Number, required: true },
    subtotal: { type: Number, default: 0 },
    transportTax: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    orderDate: { type: Date, default: Date.now, index: true },
    status: { type: String, default: 'Pending', enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'] },
    paymentMethod: { type: String, default: 'Cash on Delivery', enum: ['Cash on Delivery', 'Online Payment'] },
    deliveryAddress: String,
    lastMessageTimestamp: { type: Date, default: Date.now },
    razorpayOrderId: { type: String, unique: true, sparse: true },
    razorpayPaymentId: { type: String, unique: true, sparse: true },
});

const CustomerSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true },
    customerName: String,
    totalOrders: { type: Number, default: 0 },
    lastOrderDate: Date,
    lastKnownLocation: {
        latitude: Number,
        longitude: Number,
        address: String
    },
    lastNotificationSent: { type: Date }
});

const AdminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    totpSecret: { type: String, default: null }
});

const SettingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'Delicious Bites' },
    shopLocation: {
        latitude: { type: Number, default: 17.4399 },
        longitude: { type: Number, default: 78.4983 }
    },
    deliveryRates: [{
        kms: { type: Number, required: true },
        amount: { type: Number, required: true }
    }],
    whatsappStatus: { type: String, default: 'disconnected', enum: ['disconnected', 'qr_received', 'authenticated', 'ready', 'auth_failure', 'initializing', 'qr_error'] },
    lastAuthenticatedAt: Date,
    minSubtotalForDiscount: { type: Number, default: 200 },
    discountPercentage: { type: Number, default: 0.20 },
    isDiscountEnabled: { type: Boolean, default: true }
});

// New Schema for WhatsApp Session Data
const WhatsappSessionSchema = new mongoose.Schema({
    session: { type: Object, required: true },
    clientId: { type: String, unique: true, required: true } // Unique identifier for the session
});

const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Admin = mongoose.model('Admin', AdminSchema);
const Settings = mongoose.model('Settings', SettingsSchema);
const WhatsappSession = mongoose.model('WhatsappSession', WhatsappSessionSchema); // New model

// --- Utility Functions for Custom IDs ---
function generateCustomOrderId() {
    const timestampPart = Date.now().toString().slice(-6);
    const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `JAR${timestampPart}${randomPart}`;
}

async function generateUniquePinId() {
    let pin;
    let isUnique = false;
    while (!isUnique) {
        pin = Math.floor(1000000000 + Math.random() * 9000000000).toString();
        const existingOrder = await Order.findOne({ pinId: pin });
        if (!existingOrder) {
            isUnique = true;
        }
    }
    return pin;
}

// --- Function to seed default menu items ---
async function seedMenuItems() {
    try {
        const itemCount = await Item.countDocuments();
        if (itemCount === 0) {
            console.log('Seeding default menu items...');
            const defaultItems = [
                {
                    name: 'Classic Burger',
                    description: 'Juicy patty, fresh lettuce, tomato, and special sauce.',
                    price: 150.00,
                    imageUrl: 'https://placehold.co/400x200/FF5733/FFFFFF?text=Classic+Burger',
                    category: 'Burgers',
                    isAvailable: true,
                    isTrending: true
                },
                {
                    name: 'Veggie Pizza',
                    description: 'Loaded with fresh vegetables and mozzarella cheese.',
                    price: 250.00,
                    imageUrl: 'https://placehold.co/400x200/33FF57/FFFFFF?text=Veggie+Pizza',
                    category: 'Pizzas',
                    isAvailable: true,
                    isTrending: false
                },
                {
                    name: 'Chocolate Shake',
                    description: 'Rich and creamy chocolate milkshake.',
                    price: 80.00,
                    imageUrl: 'https://placehold.co/400x200/3357FF/FFFFFF?text=Chocolate+Shake',
                    category: 'Beverages',
                    isAvailable: true,
                    isTrending: true
                },
                {
                    name: 'French Fries',
                    description: 'Crispy golden fries, perfectly salted.',
                    price: 70.00,
                    imageUrl: 'https://placehold.co/400x200/FF33FF/FFFFFF?text=French+Fries',
                    category: 'Sides',
                    isAvailable: true,
                    isTrending: false
                },
                {
                    name: 'Chicken Biryani',
                    description: 'Aromatic basmati rice cooked with tender chicken and spices.',
                    price: 220,
                    imageUrl: 'https://placehold.co/400x200/33FFFF/FFFFFF?text=Chicken+Biryani',
                    category: 'Main Course',
                    isAvailable: true,
                    isTrending: true
                }
            ];
            await Item.insertMany(defaultItems);
            console.log('Default menu items seeded successfully.');
        } else {
            console.log('Menu items already exist. Skipping seeding.');
        }
    } catch (error) {
        console.error('Error seeding menu items:', error);
    }
}


// --- WhatsApp Client Initialization & State Management ---
let client = null;
let whatsappReady = false;
let qrCodeData = null;
let qrExpiryTimer = null;
let isInitializing = false;
let currentInitializationAttempt = 0;
const MAX_INITIALIZATION_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10000;
const QR_EXPIRY_TIME_MS = 300000; // 5 minutes

// Define the client ID for the WhatsApp session stored in MongoDB
const WHATSAPP_CLIENT_ID = 'admin';

/**
 * Initializes the WhatsApp client.
 * @param {boolean} forceNewSession - If true, forces a new QR by deleting session from DB.
 */
const initializeWhatsappClient = async (forceNewSession = false) => {
    if (isInitializing) {
        console.log('[WhatsApp] Initialization already in progress. Skipping call.');
        return;
    }

    isInitializing = true;
    currentInitializationAttempt++;
    console.log(`[WhatsApp] Starting initialization (Force new session: ${forceNewSession}). Attempt ${currentInitializationAttempt}/${MAX_INITIALIZATION_ATTEMPTS}`);

    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    io.emit('whatsapp_log', `Initializing WhatsApp client. Attempt ${currentInitializationAttempt}/${MAX_INITIALIZATION_ATTEMPTS}...`);

    if (client) {
        try {
            console.log('[WhatsApp] Destroying previous client instance...');
            io.emit('whatsapp_log', 'Destroying previous client instance...');
            await client.destroy();
            client = null;
            whatsappReady = false;
        } catch (e) {
            console.error('[WhatsApp] Error destroying old client:', e);
            io.emit('whatsapp_log', `Error destroying old client: ${e.message}`);
            client = null;
            whatsappReady = false;
        }
    }

    // If forcing a new session, delete the existing session from MongoDB
    if (forceNewSession) {
        try {
            console.log('[WhatsApp] Deleting old WhatsApp session from database...');
            await WhatsappSession.deleteOne({ clientId: WHATSAPP_CLIENT_ID });
            console.log('[WhatsApp] Old WhatsApp session deleted from database.');
            io.emit('whatsapp_log', 'Deleted old session from database.');
        } catch (err) {
            console.error('[WhatsApp] Error deleting WhatsApp session from database:', err);
            io.emit('whatsapp_log', `Error deleting old session from database: ${err.message}`);
        }
    }

    // Use MongoAuth strategy
    const store = new MongoStore({ mongoose: mongoose, collection: 'whatsapp_sessions' }); // 'whatsapp_sessions' is the collection name
    client = new Client({
        authStrategy: new LocalAuth({ // Use LocalAuth for now, as MongoAuth requires a separate package.
            clientId: WHATSAPP_CLIENT_ID,
            dataPath: path.join(__dirname, '.wwebjs_auth') // Keep local auth path for now
        }),
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-zygote',
                '--single-process',
                '--disable-gpu'
            ],
            headless: true,
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    client.on('qr', async (qr) => {
        console.log('[WhatsApp] QR RECEIVED');
        io.emit('whatsapp_log', 'QR code received. Please scan to connect your WhatsApp! 📱');
        qrCodeData = await qrcode.toDataURL(qr);
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_received', lastAuthenticatedAt: null }, { upsert: true });
        io.emit('status', 'qr_received');
        io.emit('qrCode', qrCodeData);

        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        qrExpiryTimer = setTimeout(async () => {
            if (!whatsappReady && qrCodeData !== null) {
                console.log('[WhatsApp] QR code expired. Reinitializing with new session...');
                io.emit('whatsapp_log', 'QR code expired. Reinitializing for a fresh start... 🔄');
                qrCodeData = null;
                io.emit('qrCode', null);
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
                io.emit('status', 'qr_error');
                isInitializing = false;
                initializeWhatsappClient(true);
            }
        }, QR_EXPIRY_TIME_MS);
        currentInitializationAttempt = 0;
    });

    client.on('authenticated', async (session) => {
        console.log('[WhatsApp] AUTHENTICATED');
        io.emit('whatsapp_log', 'Authenticated successfully! Your bot is almost ready. ✅');
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'authenticated', lastAuthenticatedAt: new Date() }, { upsert: true });
        io.emit('status', 'authenticated');
        io.emit('sessionInfo', { lastAuthenticatedAt: new Date() });
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        currentInitializationAttempt = 0;
    });

    client.on('ready', async () => {
        console.log('[WhatsApp] Client is ready!');
        io.emit('whatsapp_log', 'WhatsApp client is ready and connected! Let the orders roll in! 🚀');
        whatsappReady = true;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'ready' }, { upsert: true });
        io.emit('status', 'ready');
        const settings = await Settings.findOne({});
        io.emit('sessionInfo', { lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null });
        isInitializing = false;
        currentInitializationAttempt = 0;
    });

    client.on('auth_failure', async msg => {
        console.error('[WhatsApp] AUTHENTICATION FAILURE', msg);
        io.emit('whatsapp_log', `Authentication failed: ${msg}. Reinitializing for a fresh connection... ❌`);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
        io.emit('status', 'auth_failure');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        console.log('[WhatsApp] Reinitializing client due to auth_failure (forcing new session)...');
        isInitializing = false;
        client = null;
        initializeWhatsappClient(true);
    });

    client.on('disconnected', async (reason) => {
        console.log('[WhatsApp] Client was disconnected', reason);
        io.emit('whatsapp_log', `Disconnected: ${reason}. Trying to reconnect... 🔌`);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
        io.emit('status', 'disconnected');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

        isInitializing = false;
        client = null;

        if (reason === 'LOGOUT' || reason === 'PRIMARY_UNAVAILABLE' || reason === 'UNEXPECTED_LOGOUT') {
             console.log('[WhatsApp] Reinitializing client due to critical disconnection (forcing new session)...');
             io.emit('whatsapp_log', 'Critical disconnection detected. Forcing a new session to get things back online. 🚨');
             initializeWhatsappClient(true);
        } else {
            console.log(`[WhatsApp] Client disconnected for reason: ${reason}. Attempting to reconnect with existing session...`);
            io.emit('whatsapp_log', `Disconnected for reason: ${reason}. Attempting to reconnect with your saved session... 🤞`);
            if (currentInitializationAttempt < MAX_INITIALIZATION_ATTEMPTS) {
                setTimeout(() => initializeWhatsappClient(false), RETRY_DELAY_MS);
            } else {
                console.error('[WhatsApp] Max reconnection attempts reached after disconnection. Manual intervention might be needed.');
                io.emit('whatsapp_log', 'Max reconnection attempts reached. Please check the bot status and try "Load New Session" if needed. ⚠️');
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
                io.emit('status', 'disconnected');
                currentInitializationAttempt = 0;
            }
        }
    });

    // --- Message Listener ---
    client.on('message', async msg => {
        console.log(`[WhatsApp] Message received from ${msg.from}: ${msg.body}`);
        io.emit('whatsapp_log', `Message from ${msg.from}: ${msg.body}`);

        const text = msg.body ? msg.body.toLowerCase().trim() : '';

        let customerPhone = '';
        const rawChatId = msg.from;

        if (typeof rawChatId === 'string' && rawChatId.length > 0) {
            customerPhone = rawChatId.includes('@c.us') ? rawChatId.split('@')[0] : rawChatId;
            customerPhone = customerPhone.trim();
        }

        if (customerPhone.length === 0) {
            console.error(`[WhatsApp Message Handler] Invalid or empty customerPhone derived from msg.from: '${rawChatId}'. Skipping message processing.`);
            io.emit('whatsapp_log', `Skipping message: Invalid phone number from ${rawChatId}`);
            return;
        }

        const customerName = msg._data.notifyName;

        try {
            console.log(`[WhatsApp Message Handler] Attempting to find/create customer for phone: '${customerPhone}'`);
            let customer = await Customer.findOne({ customerPhone: customerPhone });

            if (!customer) {
                console.log(`[WhatsApp Message Handler] Customer ${customerPhone} not found. Attempting to create.`);
                try {
                    customer = new Customer({
                        customerPhone: customerPhone,
                        customerName: customerName || 'Unknown'
                    });
                    await customer.save();
                    console.log(`[WhatsApp Message Handler] Successfully created new customer: ${customerPhone}`);
                    io.emit('whatsapp_log', `Successfully created new customer: ${customerPhone}`);
                } catch (saveError) {
                    if (saveError.code === 11000) {
                        console.warn(`[WhatsApp Message Handler] Duplicate key error during customer creation for ${customerPhone}. Key Pattern: ${JSON.stringify(saveError.keyPattern)}, Key Value: ${JSON.stringify(saveError.keyValue)}`);
                        io.emit('whatsapp_log', `Duplicate customer found for ${customerPhone}. Attempting update.`);
                        customer = await Customer.findOne({ customerPhone: customerPhone });
                        if (customer) {
                            if (customerName && customer.customerName !== customerName) {
                                customer.customerName = customerName;
                                await customer.save();
                                console.log(`[WhatsApp Message Handler] Successfully updated existing customer name: ${customerPhone}`);
                                io.emit('whatsapp_log', `Updated existing customer: ${customerPhone}`);
                            }
                        } else {
                            console.error(`[WhatsApp Message Handler] Critical: Duplicate key error for ${customerPhone}, but customer still not found after retry.`, saveError);
                            io.emit('whatsapp_log', `Critical error: Could not find or create customer ${customerPhone}.`);
                            throw new Error(`Failed to process message: Could not establish customer record.`);
                        }
                    } else {
                        console.error(`[WhatsApp Message Handler] Error saving new customer ${customerPhone}:`, saveError);
                        throw saveError;
                    }
                }
            } else {
                console.log(`[WhatsApp Message Handler] Customer ${customerPhone} found. Checking for name update.`);
                if (customerName && customer.customerName !== customerName) {
                    customer.customerName = customerName;
                    await customer.save();
                    console.log(`[WhatsApp Message Handler] Updated existing customer name for ${customerPhone}.`);
                    io.emit('whatsapp_log', `Updated existing customer name for ${customerPhone}.`);
                }
            }

            if (msg.hasMedia && msg.type === 'location' && msg.location) {
                console.log(`[WhatsApp Message Handler] Received location from ${customerPhone}. Updating customer record.`);
                await Customer.findOneAndUpdate(
                    { customerPhone: customerPhone },
                    {
                        $set: {
                            lastKnownLocation: {
                                latitude: msg.location.latitude,
                                longitude: msg.location.longitude,
                                address: msg.location.address || 'Location shared via WhatsApp'
                            }
                        }
                    },
                    { upsert: true, new: true }
                );
                await client.sendMessage(rawChatId, 'Location updated. Thank you! We\'ll use this for your next delivery. 📍');
                console.log(`[WhatsApp Message Handler] Sent location confirmation to ${customerPhone}`);
                io.emit('whatsapp_log', `Sent location confirmation to ${customerPhone}`);
                return;
            }

            console.log(`[WhatsApp Message Handler] Processing text: '${text}' from ${customerPhone}`);
            switch (text) {
                case 'hi':
                case 'hello':
                case 'namaste':
                case 'start':
                    console.log(`[WhatsApp Message Handler] Sending welcome message to ${customerPhone}`);
                    await sendWelcomeMessage(rawChatId, customerName);
                    break;
                case '1':
                case 'menu':
                case 'view menu':
                    console.log(`[WhatsApp Message Handler] Sending menu URL to ${customerPhone}`);
                    await sendMenu(rawChatId);
                    break;
                case '2':
                case 'location':
                case 'shop location':
                    console.log(`[WhatsApp Message Handler] Sending shop location to ${customerPhone}`);
                    await sendShopLocation(rawChatId);
                    break;
                case '3':
                case 'orders':
                case 'my orders':
                    console.log(`[WhatsApp Message Handler] Sending customer orders to ${customerPhone}`);
                    await sendCustomerOrders(rawChatId, customerPhone);
                    break;
                case '4':
                case 'help':
                case 'support':
                    console.log(`[WhatsApp Message Handler] Sending help message to ${customerPhone}`);
                    await sendHelpMessage(rawChatId);
                    break;
                case 'cod':
                case 'cash on delivery':
                    console.log(`[WhatsApp Message Handler] Processing COD for ${customerPhone}`);
                    const pendingOrderCod = await Order.findOneAndUpdate(
                        { customerPhone: customerPhone, status: 'Pending' },
                        { $set: { paymentMethod: 'Cash on Delivery', status: 'Confirmed' } },
                        { new: true, sort: { orderDate: -1 } }
                    );
                    if (pendingOrderCod) {
                        await client.sendMessage(rawChatId, 'Great choice! Your order is now confirmed for Cash on Delivery. We\'re preparing it with love! 😊');
                        io.emit('new_order', pendingOrderCod);
                        console.log(`[WhatsApp Message Handler] Order ${pendingOrderCod.customOrderId} confirmed for COD.`);
                        io.emit('whatsapp_log', `Order ${pendingOrderCod.customOrderId} confirmed for COD.`);
                    } else {
                        await client.sendMessage(rawChatId, 'Hmm, it looks like you don\'t have a pending order right now. Please place an order first from our web menu! 🛒');
                        console.log(`[WhatsApp Message Handler] No pending orders for COD for ${customerPhone}.`);
                        io.emit('whatsapp_log', `No pending orders for COD for ${customerPhone}.`);
                    }
                    break;
                case 'op':
                case 'online payment':
                    console.log(`[WhatsApp Message Handler] Online payment request from ${customerPhone}`);
                    await client.sendMessage(rawChatId, 'Online payment is currently unavailable. Please select \'Cash on Delivery\' (COD) or order directly through our web menu: https://jar-menu.vercel.app 💳');
                    break;
                default:
                    console.log(`[WhatsApp Message Handler] Checking for PIN or pending order for ${customerPhone}.`);
                    if (text.length === 10 && !isNaN(text) && !text.startsWith('0')) {
                        console.log(`[WhatsApp Message Handler] Attempting to track order by PIN: ${text} for ${customerPhone}`);
                        const orderToTrack = await Order.findOne({ pinId: text });
                        if (orderToTrack) {
                            await client.sendMessage(rawChatId, `🔍 *Order Status Update*\n\nYour Order ID: ${orderToTrack.customOrderId}\nYour Unique PIN: ${orderToTrack.pinId}\n\nCurrent Status: *${orderToTrack.status}*\nTotal Amount: ₹${orderToTrack.totalAmount.toFixed(2)}\n\nItems: ${orderToTrack.items.map(item => `${item.name} x ${item.quantity}`).join(', ')}\n\nWe'll keep you posted!`);
                            console.log(`[WhatsApp Message Handler] Order ${orderToTrack.customOrderId} found for PIN ${text}.`);
                            io.emit('whatsapp_log', `Order ${orderToTrack.customOrderId} found for PIN ${text}.`);
                            return;
                        }
                    }

                    const lastOrderInteraction = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });

                    if (lastOrderInteraction && moment().diff(moment(lastOrderInteraction.orderDate), 'minutes') < 5 && lastOrderInteraction.status === 'Pending') {
                        if (!lastOrderInteraction.deliveryAddress || lastOrderInteraction.deliveryAddress === 'Address not yet provided.') {
                            console.log(`[WhatsApp Message Handler] Capturing delivery address for pending order for ${customerPhone}.`);
                            await Order.findOneAndUpdate(
                                { _id: lastOrderInteraction._id },
                                { $set: { deliveryAddress: msg.body } },
                                { new: true }
                            );
                            await client.sendMessage(rawChatId, 'Got it! Your address is saved. Now, how would you like to pay? Reply with \'Cash on Delivery\' (COD) or \'Online Payment\' (OP). 💰');
                            console.log(`[WhatsApp Message Handler] Saved address and prompted for payment for ${customerPhone}.`);
                        } else {
                            console.log(`[WhatsApp Message Handler] Unrecognized input from ${customerPhone} (has pending order with address).`);
                            await client.sendMessage(rawChatId, 'Oops! I didn\'t quite get that. Please use our web menu to order: https://jar-menu.vercel.app or type "Hi" for options. 🤷‍♀️');
                        }
                    } else {
                        console.log(`[WhatsApp Message Handler] Unrecognized input from ${customerPhone} (no recent pending order).`);
                        await client.sendMessage(rawChatId, 'Oops! I didn\'t quite get that. Please use our web menu to order: https://jar-menu.vercel.app or type "Hi" for options. 🤷‍♀️');
                    }
                    break;
            }
        } catch (error) {
            console.error(`[WhatsApp Message Handler] FATAL ERROR processing message from ${customerPhone} (rawChatId: ${rawChatId}):`, error);
            io.emit('whatsapp_log', `FATAL ERROR processing message from ${customerPhone} (rawChatId: ${rawChatId}): ${error.message}`);
            try {
                await client.sendMessage(rawChatId, 'Apologies! Something went wrong while processing your request. Please try again or type "Help" for assistance. 😔');
            } catch (sendError) {
                console.error(`[WhatsApp Message Handler] Failed to send error message to ${rawChatId}:`, sendError);
            }
        }
    });

    // --- Attempt to initialize the client ---
    try {
        console.log('[WhatsApp] Calling client.initialize()...');
        io.emit('whatsapp_log', 'Calling client.initialize()... This might take a moment. ⏳');
        await client.initialize();
        console.log('[WhatsApp] client.initialize() called successfully.');
    } catch (err) {
        console.error(`[WhatsApp] client.initialize() error: ${err.message}`);
        io.emit('whatsapp_log', `Client initialization failed: ${err.message}. Retrying... 🔄`);
        whatsappReady = false;
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

        client = null;

        if (currentInitializationAttempt < MAX_INITIALIZATION_ATTEMPTS) {
            console.log(`[WhatsApp] Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            io.emit('whatsapp_log', `Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            isInitializing = false;
            setTimeout(() => initializeWhatsappClient(false), RETRY_DELAY_MS);
        } else {
            console.error('[WhatsApp] Max initialization attempts reached. WhatsApp client failed to initialize.');
            io.emit('whatsapp_log', 'Max initialization attempts reached. WhatsApp client failed to initialize. Please check logs for details or try "Load New Session". 🛑');
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
            io.emit('status', 'qr_error');
            isInitializing = false;
            currentInitializationAttempt = 0;
        }
    }
};

// Initial call to start WhatsApp client on server startup
(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected' || settings.whatsappStatus === 'auth_failure' || settings.whatsappStatus === 'qr_error') {
        console.log('[WhatsApp] Initial startup: No settings or disconnected/failed state. Forcing new session.');
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
        initializeWhatsappClient(true); // Force a new session on initial startup if not connected
    } else {
        console.log('[WhatsApp] Initial startup: Attempting to load existing session.');
        initializeWhatsappClient(false); // Try to load existing session
    }
})();


// --- Bot Logic Functions (kept separate for clarity, but called from message listener) ---
const WEB_MENU_URL = "https://jar-menu.vercel.app"; // User provided URL

const sendWelcomeMessage = async (chatId, customerName) => {
    const menuOptions = [
        "1. *Menu*: Explore delicious dishes! 🍔🍕",
        "2. *Location*: Find our shop! 📍",
        "3. *Orders*: Track your recent meals! 📝",
        "4. *Help*: Get assistance! 🙋‍♀️"
    ];
    const welcomeText = `🌟 Welcome ${customerName || 'foodie'}! Ready to order? Visit our web menu: ${WEB_MENU_URL}\n\nOr, choose an option by replying with the *number* or *keyword*:\n\n${menuOptions.join('\n')}`;
    try {
        await client.sendMessage(chatId, welcomeText);
        io.emit('whatsapp_log', `Sent welcome message to ${chatId}`);
    } catch (error) {
        console.error(`[WhatsApp] Failed to send welcome message to ${chatId}:`, error);
        io.emit('whatsapp_log', `Failed to send welcome message to ${chatId}: ${error.message}`);
    }
};

const sendShopLocation = async (chatId) => {
    const settings = await Settings.findOne({});
    if (settings && settings.shopLocation && settings.shopLocation.latitude && settings.shopLocation.longitude) {
        const { latitude, longitude } = settings.shopLocation;
        const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        try {
            await client.sendMessage(chatId, `📍 Find us here: ${googleMapsLink}\n\nWe're waiting to serve you delicious food!`);
            io.emit('whatsapp_log', `Sent shop location to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send shop location to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send shop location to ${chatId}: ${error.message}`);
        }
    } else {
        try {
            await client.sendMessage(chatId, 'Shop location is currently unavailable. Please contact our support team for directions! 🗺️');
            io.emit('whatsapp_log', `Sent shop location unavailable message to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send shop location unavailable message to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send shop location unavailable message to ${chatId}: ${error.message}`);
        }
    }
};

const sendMenu = async (chatId) => {
    try {
        await client.sendMessage(chatId, `📜 Explore our full menu here: ${WEB_MENU_URL}\n\nGet ready for a feast! 🍽️`);
        io.emit('whatsapp_log', `Sent menu URL to ${chatId}`);
    } catch (error) {
        console.error(`[WhatsApp] Failed to send menu URL to ${chatId}:`, error);
        io.emit('whatsapp_log', `Failed to send menu URL to ${chatId}: ${error.message}`);
    }
};

const sendCustomerOrders = async (chatId, customerPhone) => {
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(3);

    if (orders.length === 0) {
        try {
            await client.sendMessage(chatId, 'Looks like you haven\'t placed any orders yet! Start your delicious journey at: ' + WEB_MENU_URL + ' 😋');
            io.emit('whatsapp_log', `Sent no orders message to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send no orders message to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send no orders message to ${chatId}: ${error.message}`);
        }
        return;
    }

    let orderListMessage = '📝 *Your Recent Orders:*\n\n';
    orders.forEach((order, index) => {
        const displayId = order.customOrderId || order._id.substring(0, 6) + '...';
        orderListMessage += `*Order ${index + 1} (ID: ${displayId})*\n`;
        if (order.pinId) {
            orderListMessage += `  PIN: ${order.pinId}\n`;
        }
        orderListMessage += `  Total: ₹${order.totalAmount.toFixed(2)}\n`;
        orderListMessage += `  Status: *${order.status}*\n`;
        orderListMessage += `  Date: ${new Date(order.orderDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
    });
    orderListMessage += "To track any order, simply reply with its 10-digit PIN. Type 'Hi' for the main menu. ✨";
    try {
        await client.sendMessage(chatId, orderListMessage);
        io.emit('whatsapp_log', `Sent past orders to ${chatId}`);
    } catch (error) {
        console.error(`[WhatsApp] Failed to send past orders to ${chatId}:`, error);
        io.emit('whatsapp_log', `Failed to send past orders to ${chatId}: ${error.message}`);
    }
};

const sendHelpMessage = async (chatId) => {
    const helpMessage = `👋 *How Can We Assist?*\n\n*Hi* - Back to the main menu\n*Menu* - Get our web menu link\n*Orders* - See your order history\n*Location* - Find our shop on the map\n*Help* - Show this message again\n\nFor direct ordering, visit: ${WEB_MENU_URL}\n\nWe're here to help! 😊`;
    try {
        await client.sendMessage(chatId, helpMessage);
        io.emit('whatsapp_log', `Sent help message to ${chatId}`);
    } catch (error) {
        console.error(`[WhatsApp] Failed to send help message to ${chatId}:`, error);
        io.emit('whatsapp_log', `Failed to send help message to ${chatId}: ${error.message}`);
    }
};

// --- Fleeting Lines for Re-Order Notifications ---
const reOrderNotificationMessagesTelugu = [
    "Feeling hungry again? 😋 New flavors await on our menu! Order now! 🚀",
    "Missing our delicious dishes? 💖 Order your next meal now!🍽️",
    "It's been a while! ⏳ It's the perfect time to re-order. Your favorite dishes are ready! ✨",
    "Special offer! 🎉 Get a discount on your next order this week. Check out the menu! 📜",
    "It's been a day since your last order from us. Re-order your favorites! 🧡",
    "Hungry? 🤤 Order your favorite meal from Delicious Bites now! 💨",
    "Want to see what's new on our menu? 👀 Order now and try it out! 🌟",
    "Have you forgotten our taste? 😋 It's the perfect time to re-order! 🥳",
    "Thinking of ordering? 🤔 This is the right hint! Order now! 👇",
    "Your last order was great, right? 😉 Get that experience again! 💯"
];

// --- Scheduled Notification Function ---
const sendReorderNotification = async () => {
    if (!whatsappReady) {
        console.log('[Scheduler] WhatsApp client not ready for scheduled notifications. Skipping job.');
        return;
    }

    console.log('[Scheduler] Running 1-day re-order notification job...');
    const oneDayAgo = moment().subtract(1, 'day').toDate();
    const twoDaysAgo = moment().subtract(2, 'days').toDate();

    try {
        const customersToNotify = await Customer.find({
            totalOrders: { $gt: 0 },
            $or: [
                { lastNotificationSent: { $exists: false } },
                { lastNotificationSent: { $lt: oneDayAgo } }
            ],
            lastOrderDate: { $lt: twoDaysAgo }
        });

        console.log(`[Scheduler] Found ${customersToNotify.length} customers to notify.`);

        for (const customer of customersToNotify) {
            const chatId = customer.customerPhone + '@c.us';
            const randomIndex = Math.floor(Math.random() * reOrderNotificationMessagesTelugu.length);
            const message = reOrderNotificationMessagesTelugu[randomIndex];

            try {
                const notificationMessage = `${message}\n\nVisit our web menu to order: ${WEB_MENU_URL}`;
                await client.sendMessage(chatId, notificationMessage);
                await Customer.findByIdAndUpdate(customer._id, { lastNotificationSent: new Date() });
                console.log(`[Scheduler] Sent re-order notification to ${customer.customerPhone}`);
                io.emit('whatsapp_log', `Sent re-order notification to ${customer.customerPhone}`);
            } catch (msgSendError) {
                console.error(`[Scheduler] Failed to send re-order notification to ${customer.customerPhone}:`, msgSendError);
                io.emit('whatsapp_log', `Failed to send re-order notification to ${customer.customerPhone}: ${msgSendError.message}`);
            }
        }
        console.log('[Scheduler] 1-day re-order notification job finished.');

    } catch (dbError) {
        console.error('[Scheduler] Error in 1-day re-order notification job (DB query):', dbError);
        io.emit('whatsapp_log', `Error in re-order notification job (DB query): ${dbError.message}`);
    }
};

cron.schedule('0 9 * * *', () => { // Schedule to run daily at 9:00 AM IST
    sendReorderNotification();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
console.log('Daily re-order notification job scheduled to run daily at 9:00 AM IST.');


// --- Admin API Routes ---
// Admin Login Endpoint
app.post('/admin/login', async (req, res) => {
    const { username, password, totpCode } = req.body;

    const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });

    if (!admin) {
        console.error('Admin user not found in database during login attempt.');
        return res.status(500).json({ message: 'Admin user not configured. Please contact server administrator.' });
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
        return res.status(401).json({ message: 'Invalid username or password.' });
    }

    if (admin.totpSecret) {
        if (!totpCode) {
            return res.status(401).json({ message: 'Two-Factor Authentication code required.', twoFactorEnabled: true });
        }

        const verified = speakeasy.totp.verify({
            secret: admin.totpSecret,
            encoding: 'base32',
            token: totpCode,
            window: 1
        });

        if (!verified) {
            return res.status(401).json({ message: 'Invalid Two-Factor Authentication code.', twoFactorEnabled: true });
        }
    }

    const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, twoFactorEnabled: !!admin.totpSecret });
});


app.get('/admin/logout', (req, res) => {
    res.send('Logged out successfully');
});

// Authentication Middleware for Admin APIs
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) {
        console.log('Unauthorized: No token provided. (API Request to ' + req.path + ')');
        return res.status(401).json({ message: 'Unauthorized: No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message, '(API Token received for ' + req.path + ')');
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ message: 'Unauthorized: Session expired. Please log in again.' });
            }
            return res.status(403).json({ message: 'Forbidden: Invalid token.' });
        }
        req.user = user;
        next();
    });
};

// --- 2FA Specific Endpoints (operate on DEFAULT_ADMIN_USERNAME) ---
app.get('/api/admin/2fa/status', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }
        res.json({ twoFactorEnabled: !!admin.totpSecret });
    } catch (error) {
        console.error('Error fetching 2FA status:', error);
        res.status(500).json({ message: 'Error fetching 2FA status.' });
    }
});

app.post('/api/admin/2fa/generate', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        const secret = speakeasy.generateSecret({
            name: `DeliciousBites Admin (${admin.username})`,
            length: 20
        });
        admin.currentTotpSecret = secret.base32; // Temporarily store in memory for verification

        qrcode.toDataURL(secret.otpauth_url, (err, data_url) => {
            if (err) {
                console.error('Error generating QR code:', err);
                return res.status(500).json({ message: 'Error generating QR code.' });
            }
            res.json({ qrCodeUrl: data_url, secret: secret.base32 });
        });

    } catch (error) {
        console.error('Error generating 2FA secret:', error);
        res.status(500).json({ message: 'Error generating 2FA secret.' });
    }
});

app.post('/api/admin/2fa/verify', authenticateToken, async (req, res) => {
    const { totpCode, secret } = req.body;
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        if (!secret) {
            return res.status(400).json({ message: 'TOTP secret is missing for verification.' });
        }

        const verified = speakeasy.totp.verify({
            secret: secret,
            encoding: 'base32',
            token: totpCode,
            window: 1
        });

        if (!verified) {
            return res.status(401).json({ verified: false, message: 'Invalid 2FA code.' });
        }

        admin.totpSecret = secret;
        await admin.save();
        res.json({ verified: true, message: '2FA successfully enabled.' });
    } catch (error) {
        console.error('Error verifying 2FA code:', error);
        res.status(500).json({ message: 'Error verifying 2FA code.' });
    }
});

app.post('/api/admin/2fa/disable', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }
        admin.totpSecret = null;
        await admin.save();
        res.json({ message: 'Two-Factor Authentication disabled successfully.' });
    } catch (error) {
        console.error('Error disabling 2FA:', error);
        res.status(500).json({ message: 'Error disabling 2FA.' });
    }
});

// --- Other Admin API Endpoints (still require authentication) ---
app.get('/api/admin/bot-status', authenticateToken, async (req, res) => {
    const settings = await Settings.findOne({});
    res.json({
        status: settings ? settings.whatsappStatus : 'disconnected',
        lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null,
        qrCodeAvailable: qrCodeData !== null
    });
});

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    console.log('[API] Admin requested to load/re-initialize session.');
    io.emit('whatsapp_log', 'Admin requested session re-initialization.');
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    isInitializing = false;
    // The user requested to trigger old data if automation failed, which means
    // we should try to load the existing session first (forceNewSession = false).
    // If that fails, the client.on('disconnected') or client.initialize() error
    // handlers will decide whether to force a new session or retry.
    initializeWhatsappClient(false); // Try to load existing session
    res.status(200).json({ message: 'Attempting to load existing session or generate QR.' });
});

app.post('/api/admin/force-new-session', authenticateToken, async (req, res) => {
    console.log('[API] Admin requested to force a new session.');
    io.emit('whatsapp_log', 'Admin requested to force a *new* session (deleting old data).');
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    isInitializing = false;
    initializeWhatsappClient(true); // Force a new session
    res.status(200).json({ message: 'Attempting to generate a new session/QR code.' });
});


app.get('/api/admin/menu', authenticateToken, async (req, res) => {
    try {
        const items = await Item.find({});
        res.json(items);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching menu items', error: error.message });
    }
});

app.get('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const item = await Item.findById(req.params.id);
        if (!item) return res.status(404).json({ message: 'Item not found' });
        res.json(item);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching menu item', error: error.message });
    }
});

app.post('/api/admin/menu', authenticateToken, async (req, res) => {
    try {
        const newItem = new Item(req.body);
        await newItem.save();
        res.status(201).json({ message: 'Menu item added successfully', item: newItem });
    } catch (error) {
        res.status(400).json({ message: 'Error adding menu item', error: error.message });
    }
});

app.put('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const updatedItem = await Item.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!updatedItem) return res.status(404).json({ message: 'Item not found' });
        res.json({ message: 'Menu item updated successfully', item: updatedItem });
    }
    catch (error) {
        res.status(400).json({ message: 'Error updating menu item', error: error.message });
    }
});

app.delete('/api/admin/menu/:id', authenticateToken, async (req, res) => {
    try {
        const deletedItem = await Item.findByIdAndDelete(req.params.id);
        if (!deletedItem) return res.status(404).json({ message: 'Item not found' });
        res.json({ message: 'Menu item deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting menu item', error: error.message });
    }
});

app.get('/api/admin/orders', authenticateToken, async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching orders', error: error.message });
    }
});

app.get('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        res.json(order);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching order', error: error.message });
    }
});

app.put('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const { status } = req.body;
        const updatedOrder = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true, runValidators: true });
        if (!updatedOrder) return res.status(404).json({ message: 'Order not found' });

        if (whatsappReady) {
            const customerChatId = updatedOrder.customerPhone.includes('@c.us') ? updatedOrder.customerPhone : updatedOrder.customerPhone + '@c.us';
            let statusMessage = '';
            switch (status) {
                case 'Confirmed':
                    statusMessage = `🎉 Great news! Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) has been *Confirmed*! We're getting started on it.`;
                    break;
                case 'Preparing':
                    statusMessage = `🍳 Good smells coming your way! Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) is now *Preparing*. Almost ready!`;
                    break;
                case 'Out for Delivery':
                    statusMessage = `🛵 Vroom vroom! Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) is *Out for Delivery*! Get ready to enjoy your meal.`;
                    break;
                case 'Delivered':
                    statusMessage = `✅ Hooray! Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) has been *Delivered*! Enjoy your Delicious Bites! We hope to serve you again soon.`;
                    break;
                case 'Cancelled':
                    statusMessage = `😔 We're sorry, your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) has been *Cancelled*. Please contact us if you have any questions.`;
                    break;
                case 'Pending': // Should ideally not be updated to Pending from other states via dashboard
                default:
                    statusMessage = `🔔 Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) status has been updated to *${status}*.`;
                    break;
            }

            try {
                await client.sendMessage(customerChatId, statusMessage);
                io.emit('whatsapp_log', `Sent order status update to ${customerChatId}: ${status}`);
            } catch (sendError) {
                console.error(`[WhatsApp] Failed to send order status update to ${customerChatId}:`, sendError);
                io.emit('whatsapp_log', `Failed to send order status update to ${customerChatId}: ${sendError.message}`);
            }
        }

        res.json({ message: 'Order status updated successfully', order: updatedOrder });
    } catch (error) {
        res.status(400).json({ message: 'Error updating order status', error: error.message });
    }
});

app.delete('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) return res.status(404).json({ message: 'Item not found' });
        res.json({ message: 'Order deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting order', error: error.message });
    }
});

app.get('/api/admin/customers', authenticateToken, async (req, res) => {
    try {
        const customers = await Customer.find({});
        res.json(customers);
    }
    catch (error) {
        res.status(500).json({ message: 'Error fetching customers', error: error.message });
    }
});

app.get('/api/admin/customers/:phone/latest-order', authenticateToken, async (req, res) => {
    try {
        const customerPhone = req.params.phone;
        const latestOrder = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });
        if (!latestOrder) {
            return res.status(404).json({ message: 'No orders found for this customer.' });
        }
        res.json(latestOrder);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching latest order', error: error.message });
    }
});

app.delete('/api/admin/customers/:id', authenticateToken, async (req, res) => {
    try {
        const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);
        if (!deletedCustomer) return res.status(404).json({ message: 'Customer not found' });
        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting customer', error: error.message });
    }
});

app.get('/api/admin/settings', authenticateToken, async (req, res) => {
    try {
        let settings = await Settings.findOne({});
        if (!settings) {
            settings = new Settings();
            await settings.save();
        }
        res.json(settings);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching settings', error: error.message });
    }
});

app.put('/api/admin/settings', authenticateToken, async (req, res) => {
    try {
        const updatedSettings = await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true, runValidators: true });
        res.json({ message: 'Settings updated successfully', settings: updatedSettings });
    }
    catch (error) {
        res.status(400).json({ message: 'Error updating settings', error: error.message });
    }
});

app.get('/api/admin/discount-settings', authenticateToken, async (req, res) => {
    try {
        const settings = await Settings.findOne({});
        if (!settings) {
            return res.json({
                minSubtotalForDiscount: 200,
                discountPercentage: 0.20,
                isDiscountEnabled: true
            });
        }
        res.json({
            minSubtotalForDiscount: settings.minSubtotalForDiscount,
            discountPercentage: settings.discountPercentage,
            isDiscountEnabled: settings.isDiscountEnabled
        });
    } catch (error) {
        console.error('Error fetching discount settings:', error);
        res.status(500).json({ message: 'Error fetching discount settings', error: error.message });
    }
});

app.put('/api/admin/discount-settings', authenticateToken, async (req, res) => {
    try {
        const { minSubtotalForDiscount, discountPercentage, isDiscountEnabled } = req.body;

        const updateFields = {};
        if (typeof minSubtotalForDiscount === 'number' && minSubtotalForDiscount >= 0) {
            updateFields.minSubtotalForDiscount = minSubtotalForDiscount;
        } else if (typeof minSubtotalForDiscount !== 'undefined') {
            return res.status(400).json({ message: 'minSubtotalForDiscount must be a non-negative number.' });
        }

        if (typeof discountPercentage === 'number' && discountPercentage >= 0 && discountPercentage <= 1) {
            updateFields.discountPercentage = discountPercentage;
        } else if (typeof discountPercentage !== 'undefined') {
            return res.status(400).json({ message: 'discountPercentage must be a number between 0 and 1 (e.g., 0.1 for 10%).' });
        }

        if (typeof isDiscountEnabled === 'boolean') {
            updateFields.isDiscountEnabled = isDiscountEnabled;
        } else if (typeof isDiscountEnabled !== 'undefined') {
            return res.status(400).json({ message: 'isDiscountEnabled must be a boolean value.' });
        }

        if (Object.keys(updateFields).length === 0) {
            return res.status(400).json({ message: 'No valid discount settings provided for update.' });
        }

        const updatedSettings = await Settings.findOneAndUpdate(
            {},
            { $set: updateFields },
            { new: true, upsert: true, runValidators: true }
        );
        res.json({ message: 'Discount settings updated successfully', settings: updatedSettings });
    } catch (error) {
        console.error('Error updating discount settings:', error);
        res.status(400).json({ message: 'Error updating discount settings', error: error.message });
    }
});


// --- Public API Routes (no authentication needed) ---
app.get('/api/menu', async (req, res) => {
    try {
        const items = await Item.find({ isAvailable: true });
        res.json(items);
    } catch (err) {
        console.error('Error fetching public menu items:', err);
        res.status(500).json({ message: 'Failed to fetch menu items.' });
    }
});

app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        if (!settings) {
            return res.json({
                shopName: 'Delicious Bites',
                shopLocation: { latitude: 17.4399, longitude: 78.4983 },
                deliveryRates: [],
                minSubtotalForDiscount: 200,
                discountPercentage: 0.20,
                isDiscountEnabled: true
            });
        }
        res.json({
            shopName: settings.shopName,
            shopLocation: settings.shopLocation,
            deliveryRates: settings.deliveryRates,
            minSubtotalForDiscount: settings.minSubtotalForDiscount,
            discountPercentage: settings.discountPercentage,
            isDiscountEnabled: settings.isDiscountEnabled
        });
    } catch (err) {
        console.error('Error fetching public settings:', err);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
});

app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, discountAmount, totalAmount, paymentMethod } = req.body;

        console.log('[API] /api/order received request body:', JSON.stringify(req.body, null, 2));

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            console.error('[API] /api/order: Missing required order details.');
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        let cleanedCustomerPhone = customerPhone.trim().replace(/\D/g, '');
        if (cleanedCustomerPhone.length === 10 && !cleanedCustomerPhone.startsWith('91')) {
            cleanedCustomerPhone = '91' + cleanedCustomerPhone;
        }
        const customerChatId = cleanedCustomerPhone + '@c.us';

        if (typeof cleanedCustomerPhone !== 'string' || cleanedCustomerPhone === '') {
            console.error('Invalid customerPhone received for order:', customerPhone);
            return res.status(400).json({ message: 'Invalid phone number provided for customer.' });
        }
        console.log(`[API] /api/order: Attempting to find/update customer with phone: '${cleanedCustomerPhone}'`);

        const itemDetails = [];
        for (const item of items) {
            const product = await Item.findById(item.productId);
            if (!product || !product.isAvailable) {
                console.error(`[API] /api/order: Item ${item.name || item.productId} is not available or not found.`);
                return res.status(400).json({ message: `Item ${item.name || item.productId} is not available.` });
            }
            itemDetails.push({
                itemId: product._id,
                name: product.name,
                price: product.price,
                quantity: item.quantity,
            });
        }

        const customOrderId = generateCustomOrderId();
        const pinId = await generateUniquePinId();

        const newOrder = new Order({
            customOrderId: customOrderId,
            pinId: pinId,
            items: itemDetails,
            customerName,
            customerPhone: cleanedCustomerPhone,
            deliveryAddress,
            customerLocation,
            subtotal,
            transportTax,
            discountAmount,
            totalAmount,
            paymentMethod: 'Cash on Delivery',
            status: 'Pending',
        });

        await newOrder.save();
        console.log('[API] /api/order: Order saved successfully.', newOrder._id);

        try {
            await Customer.findOneAndUpdate(
                { customerPhone: cleanedCustomerPhone },
                {
                    $set: {
                        customerName: customerName,
                        lastKnownLocation: customerLocation,
                        lastOrderDate: new Date()
                    },
                    $inc: { totalOrders: 1 }
                },
                { upsert: true, new: true }
            );
            console.log('[API] /api/order: Customer updated/created successfully.');
        } catch (customerUpdateError) {
            if (customerUpdateError.code === 11000 && customerUpdateError.keyPattern && customerUpdateError.keyPattern.customerPhone && customerUpdateError.keyValue && customerUpdateError.keyValue.customerPhone === null) {
                console.error(`[API] /api/order: Duplicate key error (customerPhone: null) during customer update/creation. This indicates a pre-existing null phone entry in DB. Please clean your 'customers' collection: ${customerUpdateError.message}`);
                return res.status(500).json({ message: 'Failed to update customer record due to a database conflict (duplicate null phone number). Please contact support.' });
            } else {
                console.error('[API] /api/order: Error updating/creating customer:', customerUpdateError);
                return res.status(500).json({ message: 'Failed to update customer record due to a server error.' });
            }
        }


        if (whatsappReady && client) {
            io.emit('new_order', newOrder);

            console.log(`[WhatsApp] Attempting to send order confirmation to customerChatId: ${customerChatId}`);
            try {
                let customerConfirmationMessage = `🎉 Your Delicious Bites order is placed!\n\n`;
                customerConfirmationMessage += `*Order ID:* ${newOrder.customOrderId}\n`;
                customerConfirmationMessage += `*PIN:* ${newOrder.pinId}\n\n`;
                customerConfirmationMessage += `*Items:*\n`;
                newOrder.items.forEach(item => {
                    customerConfirmationMessage += `- ${item.name} x ${item.quantity}\n`;
                });
                customerConfirmationMessage += `\n*Total:* ₹${newOrder.totalAmount.toFixed(2)}\n`;
                customerConfirmationMessage += `*Payment:* ${newOrder.paymentMethod}\n`;
                customerConfirmationMessage += `*Delivery To:* ${newOrder.deliveryAddress}\n\n`;
                customerConfirmationMessage += `We'll keep you updated on its journey! You can track it anytime by sending your PIN: *${newOrder.pinId}*. Thank you for choosing us! 🥳`;

                await client.sendMessage(customerChatId, customerConfirmationMessage);
                console.log(`[WhatsApp] Sent detailed order confirmation to ${customerChatId}`);
                io.emit('whatsapp_log', `Sent detailed order confirmation to ${customerChatId}`);
            } catch (sendError) {
                console.error(`[WhatsApp] Failed to send detailed order confirmation to ${customerChatId}:`, sendError);
                io.emit('whatsapp_log', `Failed to send detailed order confirmation to ${customerChatId}: ${sendError.message}`);
            }
        } else {
            console.warn(`[WhatsApp] WhatsApp client not ready or not initialized. Cannot send order confirmation to ${customerChatId}. whatsappReady: ${whatsappReady}, client exists: ${!!client}`);
            io.emit('whatsapp_log', `WhatsApp client not ready. Order confirmation not sent to ${customerChatId}.`);
        }

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder.customOrderId, pinId: newOrder.pinId, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        if (err.code === 11000 && err.keyPattern && err.keyPattern.customerPhone) {
            res.status(409).json({ message: 'A customer with this phone number already exists or an internal data issue occurred. Please try again with a valid phone number.' });
        } else {
            res.status(500).json({ message: 'Failed to place order due to a server error.' });
        }
    }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const queryId = req.params.id;
        let order;

        if (queryId.startsWith('JAR')) {
            order = await Order.findOne({ customOrderId: queryId });
        }
        if (!order && queryId.length === 10 && !isNaN(queryId)) {
            order = await Order.findOne({ pinId: queryId });
        }
        if (!order && mongoose.Types.ObjectId.isValid(queryId)) {
            order = await Order.findById(queryId);
        }

        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json(order);
    } catch (err) {
        console.error('Error fetching order status:', err);
        res.status(500).json({ message: 'Failed to fetch order status.' });
    }
});

app.post('/api/public/request-qr', async (req, res) => {
    if (whatsappReady) {
        return res.status(400).json({ message: 'WhatsApp client is already connected. No new QR needed.' });
    }
    console.log('[API] Public QR request received. Forcing new session initialization.');
    io.emit('whatsapp_log', 'Public QR request received. Forcing new session initialization.');
    isInitializing = false;
    initializeWhatsappClient(true);
    res.status(200).json({ message: 'Requesting new QR code. Check status page.' });
});


// --- URL Rewriting / Redirection for .html files ---
app.get('/admin/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/admin_dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/admin/login.html', (req, res) => res.redirect(301, '/admin/login'));
app.get('/menu.html', (req, res) => res.redirect(301, '/menu'));
app.get('/bot_status.html', (req, res) => res.redirect(301, '/status'));


// --- HTML Page Routes (Explicitly serve HTML files with new paths) ---
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

app.get('/track', (req, res) => {
    const orderId = req.query.orderId;
    if (orderId) {
        res.redirect(`/menu?orderId=${orderId}`);
    } else {
        res.redirect('/menu');
    }
});

app.get('/status', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

app.get('/', (req, res) => {
    res.redirect('/menu');
});

app.get('/favicon.ico', (req, res) => res.status(204).end());


// --- Serve other static assets (CSS, JS, images) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Catch-all for undefined routes ---
app.use((req, res) => {
    console.log(`Unhandled route: ${req.method} ${req.originalUrl}. Redirecting to /menu.`);
    res.redirect('/menu');
});


// --- Initial Admin User Setup on Server Startup ---
async function ensureDefaultAdminExists() {
    try {
        let admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            const hashedPassword = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
            admin = new Admin({
                username: DEFAULT_ADMIN_USERNAME,
                password: hashedPassword,
                totpSecret: null
            });
            await admin.save();
            console.log(`Default admin user '${DEFAULT_ADMIN_USERNAME}' created with 2FA disabled.`);
        } else {
            console.log(`Default admin user '${DEFAULT_ADMIN_USERNAME}' already exists.`);
        }
    } catch (error) {
        console.error('Error ensuring default admin exists:', error);
    }
}

mongoose.connection.on('connected', () => {
    ensureDefaultAdminExists();
});


// Socket.io for real-time updates
io.on('connection', (socket) => {
    console.log('Admin dashboard connected via Socket.io');
    Settings.findOne({}).then(settings => {
        if (settings) {
            socket.emit('status', settings.whatsappStatus);
            socket.emit('sessionInfo', { lastAuthenticatedAt: settings.lastAuthenticatedAt });
            if (qrCodeData) {
                socket.emit('qrCode', qrCodeData);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Admin dashboard disconnected from Socket.io');
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Login: http://localhost:${PORT}/admin/login`);
    console.log(`Admin Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`Public Menu: http://localhost:${PORT}/menu`);
    console.log(`Bot Status: http://localhost:${PORT}/status`);
    console.log(`Default Admin Username (for initial setup): ${DEFAULT_ADMIN_USERNAME}`);
    console.log(`Default Admin Password (for initial setup): ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('REMEMBER TO ENABLE 2FA FROM THE DASHBOARD AFTER FIRST LOGIN FOR SECURITY.');
});
