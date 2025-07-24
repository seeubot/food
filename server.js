const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone');
const cron = require('node-cron');
const speakeasy = require('speakeasy');
const fs = require('fs');
const crypto = require('crypto'); // Import crypto for generating unique IDs

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware for parsing JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT Secret (ensure this is in your .env file in production)
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

// --- WARNING: HARDCODED ADMIN CREDENTIALS ---
// This is for testing purposes ONLY as per user request.
// NEVER use hardcoded credentials in a production environment.
// For production, use the /admin/create-initial-admin endpoint and store credentials securely.
const DEFAULT_ADMIN_USERNAME = 'dashboard_admin';
const DEFAULT_ADMIN_PASSWORD = 'password123';
// --- END WARNING ---

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
    customOrderId: { type: String, unique: true, sparse: true }, // Custom user-facing order ID
    pinId: { type: String, unique: true, sparse: true }, // 10-digit PIN for lookup
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
    discountAmount: { type: Number, default: 0 }, // Added discountAmount to schema
    orderDate: { type: Date, default: Date.now, index: true }, // Indexed for faster sorting
    status: { type: String, default: 'Pending', enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'] },
    paymentMethod: { type: String, default: 'Cash on Delivery', enum: ['Cash on Delivery', 'Online Payment'] },
    deliveryAddress: String,
    lastMessageTimestamp: { type: Date, default: Date.now },
    razorpayOrderId: { type: String, unique: true, sparse: true }, // Kept sparse for historical data, not populated for new orders
    razorpayPaymentId: { type: String, unique: true, sparse: true }, // Kept sparse for historical data, not populated for new orders
});

const CustomerSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true }, // Ensure this is unique
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
    // New fields for discount settings
    minSubtotalForDiscount: { type: Number, default: 200 },
    discountPercentage: { type: Number, default: 0.20 } // Stored as a decimal (0.20 for 20%)
});

const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Admin = mongoose.model('Admin', AdminSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// --- Utility Functions for Custom IDs ---
function generateCustomOrderId() {
    const timestampPart = Date.now().toString().slice(-6); // Last 6 digits of timestamp
    const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 random chars
    return `JAR${timestampPart}${randomPart}`;
}

async function generateUniquePinId() {
    let pin;
    let isUnique = false;
    while (!isUnique) {
        // Generate a random 10-digit number as a string
        pin = Math.floor(1000000000 + Math.random() * 9000000000).toString();
        const existingOrder = await Order.findOne({ pinId: pin });
        if (!existingOrder) {
            isUnique = true;
        }
    }
    return pin;
}

// --- New: Function to seed default menu items ---
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
let whatsappReady = false; // True when client.on('ready') fires
let qrCodeData = null; // Stores the base64 QR image
let qrExpiryTimer = null; // Timer for QR code expiry
let isInitializing = false; // Flag to prevent multiple concurrent initializations
let currentInitializationAttempt = 0; // Tracks attempts for current client.initialize() call
const MAX_INITIALIZATION_ATTEMPTS = 5; // Increased max retries for client.initialize()
const RETRY_DELAY_MS = 10000; // Increased delay before retying initialization (10 seconds)
const QR_EXPIRY_TIME_MS = 300000; // Increased QR expiry time to 5 minutes (300 seconds)

const SESSION_PATH = path.join(__dirname, '.wwebjs_auth');

/**
 * Deletes WhatsApp session files.
 */
const deleteSessionFiles = async () => {
    console.log('[WhatsApp] Attempting to delete WhatsApp session files...');
    try {
        if (fs.existsSync(SESSION_PATH)) {
            await fs.promises.rm(SESSION_PATH, { recursive: true, force: true });
            console.log('[WhatsApp] WhatsApp session files deleted successfully.');
        } else {
            console.log('[WhatsApp] No WhatsApp session files found to delete.');
        }
    } catch (err) {
        console.error('[WhatsApp] Error deleting WhatsApp session files:', err);
    }
};

/**
 * Initializes the WhatsApp client.
 * @param {boolean} forceNewSession - If true, deletes existing session files and forces a new QR.
 */
const initializeWhatsappClient = async (forceNewSession = false) => {
    if (isInitializing) {
        console.log('[WhatsApp] Initialization already in progress. Skipping call.');
        return;
    }

    isInitializing = true;
    currentInitializationAttempt++;
    console.log(`[WhatsApp] Starting initialization (Force new session: ${forceNewSession}). Attempt ${currentInitializationAttempt}/${MAX_INITIALIZATION_ATTEMPTS}`);

    // Update status in DB and emit to dashboard
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    io.emit('whatsapp_log', `Initializing WhatsApp client. Attempt ${currentInitializationAttempt}/${MAX_INITIALIZATION_ATTEMPTS}...`);


    // If client instance exists, destroy it first to ensure a clean slate
    if (client) {
        try {
            console.log('[WhatsApp] Destroying previous client instance...');
            io.emit('whatsapp_log', 'Destroying previous client instance...');
            await client.destroy();
            client = null; // Set client to null AFTER successful destroy
            whatsappReady = false; // Reset ready state
        } catch (e) {
            console.error('[WhatsApp] Error destroying old client:', e);
            io.emit('whatsapp_log', `Error destroying old client: ${e.message}`);
            client = null; // Ensure client is null even if destroy fails
            whatsappReady = false;
        }
    }

    // Delete session files if forcing a new session
    if (forceNewSession) {
        await deleteSessionFiles();
        io.emit('whatsapp_log', 'Deleted old session files.');
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'admin',
            dataPath: SESSION_PATH
        }),
        puppeteer: {
            // Added more robust puppeteer args for better stability
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Recommended for Docker/Linux environments
                '--disable-accelerated-2d-canvas',
                '--no-zygote',
                '--single-process', // Use if experiencing issues with multiple processes
                '--disable-gpu' // Disable GPU hardware acceleration
            ],
            headless: true,
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    // --- WhatsApp Client Event Listeners ---
    client.on('qr', async (qr) => {
        console.log('[WhatsApp] QR RECEIVED');
        io.emit('whatsapp_log', 'QR code received. Please scan...');
        qrCodeData = await qrcode.toDataURL(qr);
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_received', lastAuthenticatedAt: null }, { upsert: true });
        io.emit('status', 'qr_received');
        io.emit('qrCode', qrCodeData); // Emit QR code immediately

        // Clear any existing QR expiry timer
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        qrExpiryTimer = setTimeout(async () => {
            // Only reinitialize if QR is still active and client is not ready/authenticated
            if (!whatsappReady && qrCodeData !== null) {
                console.log('[WhatsApp] QR code expired. Reinitializing with new session...');
                io.emit('whatsapp_log', 'QR code expired. Reinitializing...');
                qrCodeData = null;
                io.emit('qrCode', null);
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
                io.emit('status', 'qr_error');
                isInitializing = false; // Allow re-initialization
                initializeWhatsappClient(true); // Force a new session
            }
        }, QR_EXPIRY_TIME_MS); // Use increased QR expiry time
        currentInitializationAttempt = 0; // Reset retry count upon successful QR generation
    });

    client.on('authenticated', async (session) => {
        console.log('[WhatsApp] AUTHENTICATED');
        io.emit('whatsapp_log', 'Authenticated successfully.');
        whatsappReady = false; // Not yet ready, but authenticated
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'authenticated', lastAuthenticatedAt: new Date() }, { upsert: true });
        io.emit('status', 'authenticated');
        io.emit('sessionInfo', { lastAuthenticatedAt: new Date() });
        qrCodeData = null; // Clear QR data
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer); // Clear QR expiry timer
        currentInitializationAttempt = 0; // Reset retry count upon authentication
    });

    client.on('ready', async () => {
        console.log('[WhatsApp] Client is ready!');
        io.emit('whatsapp_log', 'WhatsApp client is ready and connected!');
        whatsappReady = true;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'ready' }, { upsert: true });
        io.emit('status', 'ready');
        // Ensure lastAuthenticatedAt is up-to-date, fetch from DB if needed
        const settings = await Settings.findOne({});
        io.emit('sessionInfo', { lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null });
        isInitializing = false; // Initialization complete
        currentInitializationAttempt = 0; // Reset retry count when ready
    });

    client.on('auth_failure', async msg => {
        console.error('[WhatsApp] AUTHENTICATION FAILURE', msg);
        io.emit('whatsapp_log', `Authentication failed: ${msg}. Reinitializing...`);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
        io.emit('status', 'auth_failure');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        console.log('[WhatsApp] Reinitializing client due to auth_failure (forcing new session)...');
        isInitializing = false; // Allow re-initialization
        client = null; // Ensure client is null before forcing new session
        initializeWhatsappClient(true); // Force a new session after auth failure
    });

    client.on('disconnected', async (reason) => {
        console.log('[WhatsApp] Client was disconnected', reason);
        io.emit('whatsapp_log', `Disconnected: ${reason}.`);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
        io.emit('status', 'disconnected');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

        isInitializing = false; // Allow re-initialization
        client = null; // Ensure client is null on disconnection

        // Decide whether to force a new session or try to reconnect with existing one
        if (reason === 'LOGOUT' || reason === 'PRIMARY_UNAVAILABLE' || reason === 'UNEXPECTED_LOGOUT') {
             console.log('[WhatsApp] Reinitializing client due to critical disconnection (forcing new session)...');
             io.emit('whatsapp_log', 'Critical disconnection. Forcing new session...');
             initializeWhatsappClient(true); // Force a new session
        } else {
            console.log(`[WhatsApp] Client disconnected for reason: ${reason}. Attempting to reconnect with existing session...`);
            io.emit('whatsapp_log', `Disconnected for reason: ${reason}. Attempting to reconnect...`);
            // Only retry if we haven't reached max attempts for this specific client.initialize() call
            if (currentInitializationAttempt < MAX_INITIALIZATION_ATTEMPTS) {
                setTimeout(() => initializeWhatsappClient(false), RETRY_DELAY_MS);
            } else {
                console.error('[WhatsApp] Max reconnection attempts reached after disconnection. Manual intervention might be needed.');
                io.emit('whatsapp_log', 'Max reconnection attempts reached. Manual intervention needed.');
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
                io.emit('status', 'disconnected');
                currentInitializationAttempt = 0; // Reset for next manual attempt
            }
        }
    });

    // --- Message Listener ---
    client.on('message', async msg => {
        console.log(`[WhatsApp] Message received from ${msg.from}: ${msg.body}`);
        io.emit('whatsapp_log', `Message from ${msg.from}: ${msg.body}`);

        // Define text here at the very beginning of the message handler
        const text = msg.body ? msg.body.toLowerCase().trim() : '';

        // Extract and strictly validate customerPhone
        let customerPhone = '';
        const rawChatId = msg.from;

        if (typeof rawChatId === 'string' && rawChatId.length > 0) {
            customerPhone = rawChatId.includes('@c.us') ? rawChatId.split('@')[0] : rawChatId;
            customerPhone = customerPhone.trim(); // Ensure no leading/trailing whitespace
        }

        // If customerPhone is empty after processing, assign a unique placeholder
        // and then skip processing this message to prevent invalid data in DB.
        if (customerPhone.length === 0) {
            console.error(`[WhatsApp Message Handler] Invalid or empty customerPhone derived from msg.from: '${rawChatId}'. Skipping message processing.`);
            io.emit('whatsapp_log', `Skipping message: Invalid phone number from ${rawChatId}`);
            return; // Exit if customerPhone is invalid
        }

        const customerName = msg._data.notifyName; // This can be null/undefined

        try {
            console.log(`[WhatsApp Message Handler] Attempting to find/create customer for phone: '${customerPhone}'`); // Added log for clarity
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

            // Now process the message body (text)
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
                await client.sendMessage(rawChatId, 'Your location has been updated. Thank you!');
                console.log(`[WhatsApp Message Handler] Sent location confirmation to ${customerPhone}`);
                io.emit('whatsapp_log', `Sent location confirmation to ${customerPhone}`);
                return;
            }

            console.log(`[WhatsApp Message Handler] Processing text: '${text}' from ${customerPhone}`);
            switch (text) {
                case 'hi':
                case 'hello':
                case 'namaste':
                case 'menu':
                    console.log(`[WhatsApp Message Handler] Sending welcome message to ${customerPhone}`);
                    await sendWelcomeMessage(rawChatId, customerName);
                    break;
                case '1':
                case 'view menu':
                    console.log(`[WhatsApp Message Handler] Sending menu to ${customerPhone}`);
                    await sendMenu(rawChatId);
                    break;
                case '2':
                case 'shop location':
                    console.log(`[WhatsApp Message Handler] Sending shop location to ${customerPhone}`);
                    await sendShopLocation(rawChatId);
                    break;
                case '4':
                case 'my orders':
                    console.log(`[WhatsApp Message Handler] Sending customer orders to ${customerPhone}`);
                    await sendCustomerOrders(rawChatId, customerPhone);
                    break;
                case '5':
                case 'help':
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
                        await client.sendMessage(rawChatId, 'Your order has been confirmed for Cash on Delivery. Thank you! Your order will be processed shortly. 😊');
                        io.emit('new_order', pendingOrderCod);
                        console.log(`[WhatsApp Message Handler] Order ${pendingOrderCod.customOrderId} confirmed for COD.`);
                        io.emit('whatsapp_log', `Order ${pendingOrderCod.customOrderId} confirmed for COD.`);
                    } else {
                        await client.sendMessage(rawChatId, 'You have no pending orders. Please place an order first.');
                        console.log(`[WhatsApp Message Handler] No pending orders for COD for ${customerPhone}.`);
                        io.emit('whatsapp_log', `No pending orders for COD for ${customerPhone}.`);
                    }
                    break;
                case 'op':
                case 'online payment':
                    console.log(`[WhatsApp Message Handler] Online payment request from ${customerPhone}`);
                    await client.sendMessage(rawChatId, 'Online payment will be added soon! For now, please use Cash on Delivery or place your order through our web menu: ' + process.env.WEB_MENU_URL);
                    break;
                default:
                    console.log(`[WhatsApp Message Handler] Checking for PIN or pending order for ${customerPhone}.`);
                    // Check if the message is a PIN for order tracking
                    if (text.length === 10 && !isNaN(text) && !text.startsWith('0')) {
                        console.log(`[WhatsApp Message Handler] Attempting to track order by PIN: ${text} for ${customerPhone}`);
                        const orderToTrack = await Order.findOne({ pinId: text });
                        if (orderToTrack) {
                            await client.sendMessage(rawChatId, `Order ID: ${orderToTrack.customOrderId}\nStatus: ${orderToTrack.status}\nTotal: ₹${orderToTrack.totalAmount.toFixed(2)}\nItems: ${orderToTrack.items.map(item => `${item.name} x ${item.quantity}`).join(', ')}`);
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
                            await client.sendMessage(rawChatId, 'Your delivery address has been saved. Please choose your payment method: ' +
                                                    "'Cash on Delivery' (COD) or 'Online Payment' (OP).");
                            console.log(`[WhatsApp Message Handler] Saved address and prompted for payment for ${customerPhone}.`);
                        } else {
                            console.log(`[WhatsApp Message Handler] Unrecognized input from ${customerPhone} (has pending order with address).`);
                            await client.sendMessage(rawChatId, 'I did not understand your request. To place an order, please visit our web menu: ' + process.env.WEB_MENU_URL + '. You can also type "Hi" to return to the main menu or ask for "Help".');
                        }
                    } else {
                        console.log(`[WhatsApp Message Handler] Unrecognized input from ${customerPhone} (no recent pending order).`);
                        await client.sendMessage(rawChatId, 'I did not understand your request. To place an order, please visit our web menu: ' + process.env.WEB_MENU_URL + '. You can also type "Hi" to return to the main menu or ask for "Help".');
                    }
                    break;
            }
        } catch (error) {
            console.error(`[WhatsApp Message Handler] FATAL ERROR processing message from ${customerPhone} (rawChatId: ${rawChatId}):`, error);
            io.emit('whatsapp_log', `FATAL ERROR processing message from ${customerPhone} (rawChatId: ${rawChatId}): ${error.message}`);
            // Attempt to send a generic error message back to the user
            try {
                await client.sendMessage(rawChatId, 'Oops! Something went wrong while processing your request. Please try again or type "Help" for options.');
            } catch (sendError) {
                console.error(`[WhatsApp Message Handler] Failed to send error message to ${rawChatId}:`, sendError);
            }
        }
    });

    // --- Attempt to initialize the client ---
    try {
        console.log('[WhatsApp] Calling client.initialize()...');
        io.emit('whatsapp_log', 'Calling client.initialize()...');
        await client.initialize();
        console.log('[WhatsApp] client.initialize() called successfully.');
        // The 'ready' event will set isInitializing to false and reset currentInitializationAttempt
    } catch (err) {
        console.error(`[WhatsApp] client.initialize() error: ${err.message}`);
        io.emit('whatsapp_log', `client.initialize() failed: ${err.message}`);
        whatsappReady = false;
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);

        // If client.initialize() fails, ensure the 'client' instance is completely discarded
        // so that the next attempt creates a fresh one.
        client = null; // Set client to null immediately after a failed initialization

        // If initialization fails, retry if max attempts not reached
        if (currentInitializationAttempt < MAX_INITIALIZATION_ATTEMPTS) {
            console.log(`[WhatsApp] Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            io.emit('whatsapp_log', `Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            isInitializing = false; // Allow retry
            setTimeout(() => initializeWhatsappClient(false), RETRY_DELAY_MS);
        } else {
            console.error('[WhatsApp] Max initialization attempts reached. WhatsApp client failed to initialize.');
            io.emit('whatsapp_log', 'Max initialization attempts reached. WhatsApp client failed to initialize.');
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
            io.emit('status', 'qr_error');
            isInitializing = false; // Allow future manual initialization
            currentInitializationAttempt = 0; // Reset for next manual attempt
        }
    }
};

// Initial call to start WhatsApp client on server startup
(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected') {
        console.log('[WhatsApp] Initial startup: No settings or disconnected. Forcing new session.');
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
        initializeWhatsappClient(true); // Force new session on initial startup if disconnected
    } else {
        console.log('[WhatsApp] Initial startup: Attempting to load existing session.');
        initializeWhatsappClient(false);
    }
})();


// --- Bot Logic Functions (kept separate for clarity, but called from message listener) ---
const sendWelcomeMessage = async (chatId, customerName) => {
    const menuOptions = [
        "1. 📜 View Our Delicious Menu",
        "2. 📍 Get Our Shop Location",
        "4. 📝 Check Your Recent Orders",
        "5. ❓ Need Help? Ask Us Anything!"
    ];
    // Redesigned welcome message
    const welcomeText = `🌟 Hello ${customerName || 'foodie'}! Welcome to *Delicious Bites*! 😋\n\nReady to order? Visit our easy-to-use web menu here: ${process.env.WEB_MENU_URL}\n\nOr, choose from the options below to get started:\n\n${menuOptions.join('\n')}\n\nSimply reply with the *number* or *keyword* for your choice!`;
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
            await client.sendMessage(chatId, `📍 Our shop location is here:\n${googleMapsLink}\n\nWe hope to see you soon!`);
            io.emit('whatsapp_log', `Sent shop location to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send shop location to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send shop location to ${chatId}: ${error.message}`);
        }
    } else {
        try {
            await client.sendMessage(chatId, 'Sorry, shop location is currently unavailable. Please contact the admin.');
            io.emit('whatsapp_log', `Sent shop location unavailable message to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send shop location unavailable message to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send shop location unavailable message to ${chatId}: ${error.message}`);
        }
    }
};

const sendMenu = async (chatId) => {
    const items = await Item.find({ isAvailable: true });
    if (items.length === 0) {
        try {
            await client.sendMessage(chatId, 'There are currently no items on the menu. Please try again later.');
            io.emit('whatsapp_log', `Sent no menu items message to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send no menu items message to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send no menu items message to ${chatId}: ${error.message}`);
        }
        return;
    }

    let menuMessage = "📜 Our Menu:\n\n";
    const categories = {};
    items.forEach(item => {
        const category = item.category || 'Other';
        if (!categories[category]) {
            categories[category] = [];
        }
        categories[category].push(item);
    });

    for (const category in categories) {
        menuMessage += `*${category}*\n`;
        categories[category].forEach((item, index) => {
            menuMessage += `${index + 1}. ${item.name} - ₹${item.price.toFixed(2)}${item.isTrending ? ' ✨' : ''}\n`;
            if (item.description) {
                menuMessage += `   _(${item.description})_\n`;
            }
        });
        menuMessage += '\n';
    }
    menuMessage += "To place an order, please visit our web menu: " + process.env.WEB_MENU_URL + "\n\nYou can also type 'Hi' to return to the main menu.";
    try {
        await client.sendMessage(chatId, menuMessage);
        io.emit('whatsapp_log', `Sent menu to ${chatId}`);
    } catch (error) {
        console.error(`[WhatsApp] Failed to send menu to ${chatId}:`, error);
        io.emit('whatsapp_log', `Failed to send menu to ${chatId}: ${error.message}`);
    }
};

const sendCustomerOrders = async (chatId, customerPhone) => {
    // Fetch orders using customOrderId or pinId if available, otherwise use _id
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(5);

    if (orders.length === 0) {
        try {
            await client.sendMessage(chatId, 'You have not placed any orders yet.');
            io.emit('whatsapp_log', `Sent no orders message to ${chatId}`);
        } catch (error) {
            console.error(`[WhatsApp] Failed to send no orders message to ${chatId}:`, error);
            io.emit('whatsapp_log', `Failed to send no orders message to ${chatId}: ${error.message}`);
        }
        return;
    }

    let orderListMessage = 'Your Past Orders:\n\n';
    orders.forEach((order, index) => {
        const displayId = order.customOrderId || order._id.substring(0, 6) + '...';
        orderListMessage += `*Order ${index + 1} (ID: ${displayId})*\n`;
        if (order.pinId) {
            orderListMessage += `  PIN: ${order.pinId}\n`;
        }
        orderListMessage += `  Total: ₹${order.totalAmount.toFixed(2)}\n`;
        orderListMessage += `  Status: ${order.status}\n`;
        orderListMessage += `  Payment: ${order.paymentMethod}\n`;
        orderListMessage += `  Date: ${new Date(order.orderDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
    });
    try {
        await client.sendMessage(chatId, orderListMessage);
        io.emit('whatsapp_log', `Sent past orders to ${chatId}`);
    } catch (error) {
        console.error(`[WhatsApp] Failed to send past orders to ${chatId}:`, error);
        io.emit('whatsapp_log', `Failed to send past orders to ${chatId}: ${error.message}`);
    }
};

const sendHelpMessage = async (chatId) => {
    const helpMessage = `How can I help you? You can try the following:\n
*Hi* - To return to the main menu
*View Menu* - To see our available items
*My Orders* - To view your past orders
*Shop Location* - To get our shop's location
*Help* - To see this help message again\n\nTo place an order, please visit our web menu: ${process.env.WEB_MENU_URL}`;
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
    const oneDayAgo = moment().subtract(1, 'day').toDate(); // Changed from 7 days
    const twoDaysAgo = moment().subtract(2, 'days').toDate(); // Keep this to avoid spamming immediately after order

    try {
        const customersToNotify = await Customer.find({
            totalOrders: { $gt: 0 },
            $or: [
                { lastNotificationSent: { $exists: false } },
                { lastNotificationSent: { $lt: oneDayAgo } } // Use oneDayAgo here
            ],
            lastOrderDate: { $lt: twoDaysAgo } // Only notify if last order was more than 2 days ago
        });

        console.log(`[Scheduler] Found ${customersToNotify.length} customers to notify.`);

        for (const customer of customersToNotify) {
            const chatId = customer.customerPhone + '@c.us';
            const randomIndex = Math.floor(Math.random() * reOrderNotificationMessagesTelugu.length);
            const message = reOrderNotificationMessagesTelugu[randomIndex];

            try {
                const notificationMessage = `${message}\n\nVisit our web menu to order: ${process.env.WEB_MENU_URL}`;
                await client.sendMessage(chatId, notificationMessage);
                await Customer.findByIdAndUpdate(customer._id, { lastNotificationSent: new Date() });
                console.log(`[Scheduler] Sent re-order notification to ${customer.customerPhone}`);
                io.emit('whatsapp_log', `Sent re-order notification to ${customer.customerPhone}`);
            } catch (msgSendError) {
                console.error(`[Scheduler] Failed to send re-order notification to ${customer.customerPhone}:`, msgSendError);
                io.emit('whatsapp_log', `Failed to send re-order notification to ${customer.customerPhone}: ${msgSendError.message}`);
            }
        }
        console.log('[Scheduler] 1-day re-order notification job finished.'); // Updated log message

    } catch (dbError) {
        console.error('[Scheduler] Error in 1-day re-order notification job (DB query):', dbError); // Updated log message
        io.emit('whatsapp_log', `Error in re-order notification job (DB query): ${dbError.message}`);
    }
};

cron.schedule('0 9 * * *', () => {
    sendReorderNotification();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata"
});
console.log('Daily re-order notification job scheduled to run daily at 9:00 AM IST.'); // Updated log message


// --- Admin API Routes ---
app.post('/admin/login', async (req, res) => {
    const { username, password, totpCode } = req.body;

    const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });

    if (!admin) {
        return res.status(500).json({ message: 'Admin user not found in database. Please restart server.' });
    }

    // Verify password first
    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
        return res.status(401).json({ message: 'Invalid username or password.' });
    }

    if (!admin.totpSecret) {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token, twoFactorEnabled: false });
    }

    if (!totpCode) {
        return res.status(401).json({ message: 'Two-Factor Authentication code required.' });
    }

    const verified = speakeasy.totp.verify({
        secret: admin.totpSecret,
        encoding: 'base32',
        token: totpCode,
        window: 1
    });

    if (!verified) {
        return res.status(401).json({ message: 'Invalid Two-Factor Authentication code.' });
    }

    const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, twoFactorEnabled: true });
});

app.get('/admin/logout', (req, res) => {
    res.send('Logged out successfully');
});

// Authentication Middleware for Admin APIs
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    // List of HTML routes that require authentication
    // REMOVED: '/dashboard' from htmlAuthRoutes as it's now handled client-side
    const htmlAuthRoutes = []; // Now, only API calls will use this middleware for 401/403 responses

    if (token == null) {
        console.log('Unauthorized: No token provided. (Request to ' + req.path + ')');
        if (htmlAuthRoutes.includes(req.path)) {
            return res.redirect('/admin/login'); // Redirect to login for HTML pages
        }
        return res.status(401).json({ message: 'Unauthorized: No token provided.' }); // For API calls
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message, '(Token received for ' + req.path + ')');
            if (err.name === 'TokenExpiredError') {
                if (htmlAuthRoutes.includes(req.path)) {
                    return res.redirect('/admin/login'); // Redirect to login if token expired for HTML pages
                }
                return res.status(401).json({ message: 'Unauthorized: Session expired. Please log in again.' });
            }
            if (htmlAuthRoutes.includes(req.path)) {
                return res.redirect('/admin/login'); // Redirect to login for other auth errors on HTML pages
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
        // Do NOT save the secret to DB here. Only save after successful verification.
        // This prevents generating a new secret every time the modal is opened.
        // Instead, we'll return the secret and QR, and the client will verify it.
        // The secret will be temporarily stored on the client side or derived from the QR.

        // For simplicity, we'll temporarily store it on the admin object in memory
        // This is not ideal for multi-instance deployments, but fine for a single server.
        admin.currentTotpSecret = secret.base32; // Temporary in-memory storage

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
    const { totpCode, secret } = req.body; // Expect secret from frontend
    try {
        const admin = await Admin.findOne({ username: DEFAULT_ADMIN_USERNAME });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        if (!secret) {
            return res.status(400).json({ message: 'TOTP secret is missing for verification.' });
        }

        const verified = speakeasy.totp.verify({
            secret: secret, // Use the secret sent from the frontend
            encoding: 'base32',
            token: totpCode,
            window: 1
        });

        if (!verified) {
            return res.status(401).json({ verified: false, message: 'Invalid 2FA code.' });
        }

        admin.totpSecret = secret; // Save the secret to DB only upon successful verification
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
        qrCodeAvailable: qrCodeData !== null // Indicate if QR is currently available
    });
});

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    // This endpoint is primarily for admin to force a re-initialization,
    // potentially with a new QR if the current session is problematic.
    // It should always trigger a reset.
    console.log('[API] Admin requested to load/re-initialize session.');
    io.emit('whatsapp_log', 'Admin requested session re-initialization.');
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    isInitializing = false; // Allow the call to proceed
    initializeWhatsappClient(true); // Force a new session
    res.status(200).json({ message: 'Attempting to load new session or generate QR.' });
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
        // Fetch orders and sort by orderDate for admin view
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
            // Ensure customerPhone is in the correct format for whatsapp-web.js
            const customerChatId = updatedOrder.customerPhone.includes('@c.us') ? updatedOrder.customerPhone : updatedOrder.customerPhone + '@c.us';
            try {
                await client.sendMessage(customerChatId, `Your order (ID: ${updatedOrder.customOrderId || updatedOrder._id.substring(0, 6)}...) status has been updated to '${status}'.`);
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
            // Create default settings if none exist
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

// New: Admin API for Discount Settings
app.get('/api/admin/discount-settings', authenticateToken, async (req, res) => {
    try {
        const settings = await Settings.findOne({});
        if (!settings) {
            return res.status(404).json({ message: 'Discount settings not found. Please create default settings first.' });
        }
        res.json({
            minSubtotalForDiscount: settings.minSubtotalForDiscount,
            discountPercentage: settings.discountPercentage
        });
    } catch (error) {
        console.error('Error fetching discount settings:', error);
        res.status(500).json({ message: 'Error fetching discount settings', error: error.message });
    }
});

app.put('/api/admin/discount-settings', authenticateToken, async (req, res) => {
    try {
        const { minSubtotalForDiscount, discountPercentage } = req.body;

        if (typeof minSubtotalForDiscount !== 'number' || minSubtotalForDiscount < 0) {
            return res.status(400).json({ message: 'minSubtotalForDiscount must be a non-negative number.' });
        }
        if (typeof discountPercentage !== 'number' || discountPercentage < 0 || discountPercentage > 1) {
            return res.status(400).json({ message: 'discountPercentage must be a number between 0 and 1 (e.g., 0.1 for 10%).' });
        }

        const updatedSettings = await Settings.findOneAndUpdate(
            {},
            { $set: { minSubtotalForDiscount, discountPercentage } },
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
            // If no settings exist, return default public settings
            return res.json({
                shopName: 'Delicious Bites',
                shopLocation: { latitude: 17.4399, longitude: 78.4983 },
                deliveryRates: [],
                minSubtotalForDiscount: 200, // Default for public
                discountPercentage: 0.20 // Default for public
            });
        }
        res.json({
            shopName: settings.shopName,
            shopLocation: settings.shopLocation,
            deliveryRates: settings.deliveryRates,
            minSubtotalForDiscount: settings.minSubtotalForDiscount,
            discountPercentage: settings.discountPercentage
        });
    } catch (err) {
        console.error('Error fetching public settings:', err);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
});

app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, discountAmount, totalAmount, paymentMethod } = req.body;

        console.log('[API] /api/order received request body:', JSON.stringify(req.body, null, 2)); // Log incoming request

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            console.error('[API] /api/order: Missing required order details.');
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        // --- START: Improved customerPhone formatting for WhatsApp ---
        let cleanedCustomerPhone = customerPhone.trim().replace(/\D/g, ''); // Strip non-digits
        // Assuming Indian numbers (10 digits), prepend '91' if not already present
        if (cleanedCustomerPhone.length === 10 && !cleanedCustomerPhone.startsWith('91')) {
            cleanedCustomerPhone = '91' + cleanedCustomerPhone;
        }
        const customerChatId = cleanedCustomerPhone + '@c.us';
        // --- END: Improved customerPhone formatting ---

        if (typeof cleanedCustomerPhone !== 'string' || cleanedCustomerPhone === '') {
            console.error('Invalid customerPhone received for order:', customerPhone);
            return res.status(400).json({ message: 'Invalid phone number provided for customer.' });
        }
        // --- Added logging for cleanedCustomerPhone before findOneAndUpdate ---
        console.log(`[API] /api/order: Attempting to find/update customer with phone: '${cleanedCustomerPhone}'`);

        const itemDetails = [];
        for (const item of items) {
            const product = await Item.findById(item.productId); // Ensure productId matches _id in Item collection
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

        // Generate custom order ID and PIN ID for all orders
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
            discountAmount, // Save the discount amount
            totalAmount,
            paymentMethod: 'Cash on Delivery', // Force to Cash on Delivery as online is removed
            status: 'Pending', // All new orders start as Pending
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


        // --- START: Send order confirmation to customer via WhatsApp ---
        if (whatsappReady && client) { // Ensure client is ready and initialized
            io.emit('new_order', newOrder); // Still emit to admin dashboard

            console.log(`[WhatsApp] Attempting to send order confirmation to customerChatId: ${customerChatId}`); // Log target ID
            try {
                // Construct the detailed order confirmation message for the customer
                let customerConfirmationMessage = `🎉 Your order from Delicious Bites has been placed successfully!\n\n`;
                customerConfirmationMessage += `*Order ID:* ${newOrder.customOrderId}\n`;
                customerConfirmationMessage += `*PIN:* ${newOrder.pinId}\n\n`;
                customerConfirmationMessage += `*Your Items:*\n`;
                newOrder.items.forEach(item => {
                    customerConfirmationMessage += `- ${item.name} x ${item.quantity} (₹${item.price.toFixed(2)} each)\n`;
                });
                customerConfirmationMessage += `\n*Subtotal:* ₹${newOrder.subtotal.toFixed(2)}\n`;
                customerConfirmationMessage += `*Transport Tax:* ₹${newOrder.transportTax.toFixed(2)}\n`;
                if (newOrder.discountAmount > 0) {
                    customerConfirmationMessage += `*Discount:* -₹${newOrder.discountAmount.toFixed(2)}\n`;
                }
                customerConfirmationMessage += `*Total Amount:* ₹${newOrder.totalAmount.toFixed(2)}\n`;
                customerConfirmationMessage += `*Payment Method:* ${newOrder.paymentMethod}\n`;
                customerConfirmationMessage += `*Delivery Address:* ${newOrder.deliveryAddress}\n\n`;
                customerConfirmationMessage += `We will notify you of its status updates. You can also view your orders by typing "My Orders" or by sending your PIN: ${newOrder.pinId}. Thank you for your order! 🥳`;

                await client.sendMessage(customerChatId, customerConfirmationMessage);
                console.log(`[WhatsApp] Sent detailed order confirmation to ${customerChatId}`);
                io.emit('whatsapp_log', `Sent detailed order confirmation to ${customerChatId}`);
            } catch (sendError) {
                console.error(`[WhatsApp] Failed to send detailed order confirmation to ${customerChatId}:`, sendError);
                io.emit('whatsapp_log', `Failed to send detailed order confirmation to ${customerChatId}: ${sendError.message}`);
            }
        } else {
            console.warn(`[WhatsApp] WhatsApp client not ready or not initialized. Cannot send order confirmation to ${customerChatId}. whatsappReady: ${whatsappReady}, client exists: ${!!client}`); // Added warning
            io.emit('whatsapp_log', `WhatsApp client not ready. Order confirmation not sent to ${customerChatId}.`);
        }
        // --- END: Send order confirmation to customer via WhatsApp ---

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder.customOrderId, pinId: newOrder.pinId, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        // This catch block will now primarily handle errors from newOrder.save() or initial validation
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

        // Try to find by customOrderId, then by pinId, then by MongoDB _id
        if (queryId.startsWith('JAR')) {
            order = await Order.findOne({ customOrderId: queryId });
        }
        if (!order && queryId.length === 10 && !isNaN(queryId)) { // Check if it looks like a PIN
            order = await Order.findOne({ pinId: queryId });
        }
        if (!order && mongoose.Types.ObjectId.isValid(queryId)) { // Fallback to MongoDB _id
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
    // This endpoint should always force a new QR generation if the client is not ready.
    // If it's already ready, we should prevent requesting a new QR.
    if (whatsappReady) {
        return res.status(400).json({ message: 'WhatsApp client is already connected. No new QR needed.' });
    }
    console.log('[API] Public QR request received. Forcing new session initialization.');
    io.emit('whatsapp_log', 'Public QR request received. Forcing new session initialization.');
    isInitializing = false; // Allow the call to proceed
    initializeWhatsappClient(true); // Force a new session to get a new QR
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

// MODIFICATION START: Removed authenticateToken middleware from /dashboard route
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
// MODIFICATION END

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

// Changed default route to redirect to /menu
app.get('/', (req, res) => {
    res.redirect('/menu');
});

// Add favicon.ico handler to prevent it from hitting the catch-all
app.get('/favicon.ico', (req, res) => res.status(204).end());


// --- Serve other static assets (CSS, JS, images) ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Catch-all for undefined routes ---
// Changed catch-all to redirect to /menu for better public user experience
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
            if (qrCodeData) { // If QR is already available, send it to newly connected client
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
