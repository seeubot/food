const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const moment = require('moment-timezone'); // For time zone handling
const cron = require('node-cron'); // Import node-cron
const speakeasy = require('speakeasy'); // Import speakeasy for TOTP

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware for parsing JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT Secret (ensure this is in your .env file in production)
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey'; // Fallback for safety, but should be set in .env

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true, // This is a deprecated option, but keeping it for compatibility if needed.
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
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
    customerPhone: { type: String, required: true },
    customerName: String,
    customerLocation: {
        latitude: Number,
        longitude: Number,
        address: String // Store the address string if available
    },
    items: [{
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
        name: String, // Store name at time of order
        price: Number, // Store price at time of order
        quantity: { type: Number, required: true }
    }],
    totalAmount: { type: Number, required: true },
    subtotal: { type: Number, default: 0 },
    transportTax: { type: Number, default: 0 },
    orderDate: { type: Date, default: Date.now },
    status: { type: String, default: 'Pending', enum: ['Pending', 'Confirmed', 'Preparing', 'Out for Delivery', 'Delivered', 'Cancelled'] },
    paymentMethod: { type: String, default: 'Cash on Delivery', enum: ['Cash on Delivery', 'Online Payment'] },
    deliveryAddress: String, // Storing the full delivery address
    // Add a field to track latest messages for context
    lastMessageTimestamp: { type: Date, default: Date.now }
});

const CustomerSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true },
    customerName: String,
    totalOrders: { type: Number, default: 0 },
    lastOrderDate: Date,
    lastKnownLocation: { // Updated to store last known delivery location
        latitude: Number,
        longitude: Number,
        address: String
    },
    lastNotificationSent: { type: Date } // New field for 7-day notification
});

const AdminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    totpSecret: { type: String, default: null } // New field for TOTP secret
});

const SettingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'Delicious Bites' },
    shopLocation: {
        latitude: { type: Number, default: 17.4399 }, // Default to a central point in Hyderabad
        longitude: { type: Number, default: 78.4983 }
    },
    deliveryRates: [{
        kms: { type: Number, required: true },
        amount: { type: Number, required: true }
    }],
    whatsappStatus: { type: String, default: 'disconnected', enum: ['disconnected', 'qr_received', 'authenticated', 'ready', 'auth_failure', 'initializing', 'qr_error'] },
    lastAuthenticatedAt: Date
});

const Item = mongoose.model('Item', ItemSchema);
const Order = mongoose.model('Order', OrderSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const Admin = mongoose.model('Admin', AdminSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// WhatsApp Client Initialization
let client;
let whatsappReady = false;
let qrCodeData = null; // Store QR code data URL
let qrExpiryTimer = null; // Timer for QR code expiry
let qrGeneratedTimestamp = null; // Timestamp when QR was generated

// Retry configuration for WhatsApp client initialization
const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000; // 5 seconds

const initializeWhatsappClient = async (loadSession = false, retryCount = 0) => {
    console.log(`Initializing WhatsApp client (Load session: ${loadSession ? 'Yes' : 'No'})... Attempt ${retryCount + 1}/${MAX_RETRIES}`);

    if (client) {
        try {
            console.log('Destroying previous client instance...');
            await client.destroy();
            console.log('Previous client destroyed successfully.');
            client = null;
        } catch (e) {
            console.error('Error destroying old client:', e);
            // If destruction fails, it might be in a bad state, so proceed with new client anyway.
            client = null;
        }
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'admin',
            dataPath: path.join(__dirname, '.wwebjs_auth')
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true,
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
    });

    // --- All client.on() listeners moved inside this function ---
    client.on('qr', async (qr) => {
        console.log('QR RECEIVED');
        qrCodeData = await qrcode.toDataURL(qr);
        qrGeneratedTimestamp = Date.now();
        io.emit('qrCode', qrCodeData);
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_received', lastAuthenticatedAt: null }, { upsert: true });
        io.emit('status', 'qr_received');

        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        qrExpiryTimer = setTimeout(async () => {
            if (whatsappReady === false && qrCodeData !== null) {
                console.log('QR code expired. Reinitializing...');
                qrCodeData = null;
                io.emit('qrCode', null);
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
                io.emit('status', 'qr_error');
                initializeWhatsappClient(); // Reinitialize to get a new QR
            }
        }, 60000);
    });

    client.on('authenticated', async (session) => {
        console.log('AUTHENTICATED');
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'authenticated', lastAuthenticatedAt: new Date() }, { upsert: true });
        io.emit('status', 'authenticated');
        io.emit('sessionInfo', { lastAuthenticatedAt: new Date() });
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    });

    client.on('ready', async () => {
        console.log('Client is ready!');
        whatsappReady = true;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'ready' }, { upsert: true });
        io.emit('status', 'ready');
        io.emit('sessionInfo', { lastAuthenticatedAt: (await Settings.findOne({})).lastAuthenticatedAt });
    });

    client.on('auth_failure', async msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
        io.emit('status', 'auth_failure');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    });

    client.on('disconnected', async (reason) => {
        console.log('Client was disconnected', reason);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
        io.emit('status', 'disconnected');
        qrCodeData = null;
        io.emit('qrCode', null);
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        // Attempt to re-initialize client after disconnection
        if (reason === 'PRIMARY_UNAVAILABLE' || reason === 'UNLAUNCHED') {
             console.log('Reinitializing client due to disconnection...');
             initializeWhatsappClient();
        }
    });

    client.on('message', async msg => {
        const chatId = msg.from;
        const text = msg.body.toLowerCase().trim();
        const customerPhone = chatId.includes('@c.us') ? chatId.split('@')[0] : chatId;
        const customerName = msg._data.notifyName;

        if (msg.hasMedia && msg.type === 'location' && msg.location) {
            const { latitude, longitude, address } = msg.location;
            await Customer.findOneAndUpdate(
                { customerPhone: customerPhone },
                {
                    $set: {
                        lastKnownLocation: {
                            latitude: latitude,
                            longitude: longitude,
                            address: address || 'Location shared via WhatsApp'
                        }
                    }
                },
                { upsert: true, new: true }
            );
            await client.sendMessage(chatId, 'Your location has been updated. Thank you!');
            return;
        }

        let customer = await Customer.findOne({ customerPhone: customerPhone });
        if (!customer) {
            customer = new Customer({ customerPhone: customerPhone, customerName: customerName });
            await customer.save();
        } else {
            if (customer.customerName !== customerName) {
                customer.customerName = customerName;
                await customer.save();
            }
        }

        switch (text) {
            case 'hi':
            case 'hello':
            case 'namaste':
            case 'menu':
                await sendWelcomeMessage(chatId, customerName);
                break;
            case '1':
            case 'view menu':
                await sendMenu(chatId);
                break;
            case '2':
            case 'shop location':
                await sendShopLocation(chatId);
                break;
            // Removed direct order placement option (case '3' / 'place order')
            case '4':
            case 'my orders':
                await sendCustomerOrders(chatId, customerPhone);
                break;
            case '5':
            case 'help':
                await sendHelpMessage(chatId);
                break;
            case 'cod':
            case 'cash on delivery':
                const pendingOrderCod = await Order.findOneAndUpdate(
                    { customerPhone: customerPhone, status: 'Pending' },
                    { $set: { paymentMethod: 'Cash on Delivery', status: 'Confirmed' } },
                    { new: true, sort: { orderDate: -1 } }
                );
                if (pendingOrderCod) {
                    await client.sendMessage(chatId, 'Your order has been confirmed for Cash on Delivery. Thank you! Your order will be processed shortly. 😊');
                    io.emit('new_order', pendingOrderCod);
                } else {
                    await client.sendMessage(chatId, 'You have no pending orders. Please place an order first.');
                }
                break;
            case 'op':
            case 'online payment':
                const pendingOrderOp = await Order.findOneAndUpdate(
                    { customerPhone: customerPhone, status: 'Pending' },
                    { $set: { paymentMethod: 'Online Payment' } },
                    { new: true, sort: { orderDate: -1 } }
                );
                if (pendingOrderOp) {
                    await client.sendMessage(chatId, 'Thank you for choosing online payment. A payment link will be sent to you shortly. Your Order ID: ' + pendingOrderOp._id.substring(0,6) + '...');
                    io.emit('new_order', pendingOrderOp);
                } else {
                    await client.sendMessage(chatId, 'You have no pending orders. Please place an order first.');
                }
                break;
            default:
                // Modified default response to guide users to the web menu for ordering
                const lastOrderInteraction = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });

                // If there's a recent pending order, still allow address/payment confirmation
                if (lastOrderInteraction && moment().diff(moment(lastOrderInteraction.orderDate), 'minutes') < 5 && lastOrderInteraction.status === 'Pending') {
                    if (!lastOrderInteraction.deliveryAddress || lastOrderInteraction.deliveryAddress === 'Address not yet provided.') {
                        await Order.findOneAndUpdate(
                            { _id: lastOrderInteraction._id },
                            { $set: { deliveryAddress: msg.body } },
                            { new: true }
                        );
                        await client.sendMessage(chatId, 'Your delivery address has been saved. Please choose your payment method: ' +
                                                  "'Cash on Delivery' (COD) or 'Online Payment' (OP).");
                    } else {
                        await client.sendMessage(chatId, 'I did not understand your request. To place an order, please visit our web menu: ' + process.env.WEB_MENU_URL + '. You can also type "Hi" to return to the main menu or ask for "Help".');
                    }
                } else {
                    await client.sendMessage(chatId, 'I did not understand your request. To place an order, please visit our web menu: ' + process.env.WEB_MENU_URL + '. You can also type "Hi" to return to the main menu or ask for "Help".');
                }
                break;
        }
    });

    try {
        await client.initialize();
        console.log('WhatsApp client initialized successfully.');
    } catch (err) {
        console.error(`Client initialization error: ${err.message}`);
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying initialization in ${RETRY_DELAY_MS / 1000} seconds...`);
            setTimeout(() => initializeWhatsappClient(loadSession, retryCount + 1), RETRY_DELAY_MS);
        } else {
            console.error('Max retries reached. WhatsApp client failed to initialize.');
            whatsappReady = false;
            await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
            io.emit('status', 'auth_failure');
            qrCodeData = null;
            io.emit('qrCode', null);
        }
    }
};

// Initial WhatsApp client setup (without loading session explicitly on startup)
(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected') {
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    }
    initializeWhatsappClient(); // Call initializeWhatsappClient here to ensure it runs when the server starts
})();


// --- Bot Logic ---

const sendWelcomeMessage = async (chatId, customerName) => {
    const menuOptions = [
        "1. 🍕 View Menu",
        "2. 📍 Shop Location",
        // Removed option 3: "3. 📞 Place Order"
        "4. 📝 My Orders",
        "5. ℹ️ Help"
    ];
    const welcomeText = `👋 Hello ${customerName || 'customer'}! Welcome to Delicious Bites! 🌟\n\nTo place an order, please visit our web menu: ${process.env.WEB_MENU_URL}\n\nHow can I help you otherwise?\n\n${menuOptions.join('\n')}\n\nChoose an option above.`;
    await client.sendMessage(chatId, welcomeText);
};

const sendShopLocation = async (chatId) => {
    const settings = await Settings.findOne({});
    if (settings && settings.shopLocation && settings.shopLocation.latitude && settings.shopLocation.longitude) {
        const { latitude, longitude } = settings.shopLocation;
        const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        await client.sendMessage(chatId, `📍 Our shop location is here:\n${googleMapsLink}\n\nWe hope to see you soon!`);
    } else {
        await client.sendMessage(chatId, 'Sorry, shop location is currently unavailable. Please contact the admin.');
    }
};

const sendMenu = async (chatId) => {
    const items = await Item.find({ isAvailable: true });
    if (items.length === 0) {
        await client.sendMessage(chatId, 'There are currently no items on the menu. Please try again later.');
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
    await client.sendMessage(chatId, menuMessage);
};

// Removed handleOrderRequest and processOrder functions as they are no longer used for direct chat ordering.
// const handleOrderRequest = async (msg) => { ... }
// const processOrder = async (msg) => { ... }


const sendCustomerOrders = async (chatId, customerPhone) => {
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(5);

    if (orders.length === 0) {
        await client.sendMessage(chatId, 'You have not placed any orders yet.');
        return;
    }

    let orderListMessage = 'Your Past Orders:\n\n';
    orders.forEach((order, index) => {
        orderListMessage += `*Order ${index + 1} (ID: ${order._id.substring(0, 6)}...)*\n`;
        order.items.forEach(item => {
            orderListMessage += `  - ${item.name} x ${item.quantity}\n`;
        });
        orderListMessage += `  Total: ₹${order.totalAmount.toFixed(2)}\n`;
        orderListMessage += `  Status: ${order.status}\n`;
        orderListMessage += `  Date: ${new Date(order.orderDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
    });
    await client.sendMessage(chatId, orderListMessage);
};

const sendHelpMessage = async (chatId) => {
    const helpMessage = `How can I help you? You can try the following:\n
*Hi* - To return to the main menu
*View Menu* - To see our available items
*My Orders* - To view your past orders
*Shop Location* - To get our shop's location
*Help* - To see this help message again\n\nTo place an order, please visit our web menu: ${process.env.WEB_MENU_URL}`;
    await client.sendMessage(chatId, helpMessage);
};

// --- Fleeting Lines for Re-Order Notifications (in English) ---
const reOrderNotificationMessagesTelugu = [
    "Feeling hungry again? 😋 New flavors await on our menu! Order now! 🚀",
    "Missing our delicious dishes? 💖 Order your next meal now! 🍽️",
    "7 days have passed! ⏳ It's the perfect time to re-order. Your favorite dishes are ready! ✨",
    "Special offer! 🎉 Get a discount on your next order this week. Check out the menu! 📜",
    "It's been 7 days since your last order from us. Re-order your favorites! 🧡",
    "Hungry? 🤤 Order your favorite meal from Delicious Bites now! 💨",
    "Want to see what's new on our menu? 👀 Order now and try it out! 🌟",
    "Have you forgotten our taste? 😋 It's the perfect time to re-order! 🥳",
    "Thinking of ordering? 🤔 This is the right hint! Order now! 👇",
    "Your last order was great, right? 😉 Get that experience again! 💯"
];

// --- Scheduled Notification Function ---
const sendReorderNotification = async () => {
    if (!whatsappReady) {
        console.log('WhatsApp client not ready for scheduled notifications. Skipping job.');
        return;
    }

    console.log('Running 7-day re-order notification job...');
    const sevenDaysAgo = moment().subtract(7, 'days').toDate();
    const twoDaysAgo = moment().subtract(2, 'days').toDate(); // Avoid spamming recent customers

    try {
        const customersToNotify = await Customer.find({
            totalOrders: { $gt: 0 }, // Must have at least one order
            $or: [
                { lastNotificationSent: { $exists: false } }, // Never notified
                { lastNotificationSent: { $lt: sevenDaysAgo } } // Notified more than 7 days ago
            ],
            lastOrderDate: { $lt: twoDaysAgo } // Last order was more than 2 days ago
        });

        console.log(`Found ${customersToNotify.length} customers to notify.`);

        for (const customer of customersToNotify) {
            const chatId = customer.customerPhone + '@c.us';
            const randomIndex = Math.floor(Math.random() * reOrderNotificationMessagesTelugu.length);
            const message = reOrderNotificationMessagesTelugu[randomIndex];

            try {
                // Append web menu URL to the notification message
                const notificationMessage = `${message}\n\nVisit our web menu to order: ${process.env.WEB_MENU_URL}`;
                await client.sendMessage(chatId, notificationMessage);
                await Customer.findByIdAndUpdate(customer._id, { lastNotificationSent: new Date() });
                console.log(`Sent re-order notification to ${customer.customerPhone}`);
            } catch (msgSendError) {
                console.error(`Failed to send re-order notification to ${customer.customerPhone}:`, msgSendError);
            }
        }
        console.log('7-day re-order notification job finished.');

    } catch (dbError) {
        console.error('Error in 7-day re-order notification job (DB query):', dbError);
    }
};

// --- Schedule the 7-day notification job ---
cron.schedule('0 9 * * *', () => { // Runs every day at 09:00 AM
    sendReorderNotification();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Set your desired timezone
});
console.log('7-day re-order notification job scheduled to run daily at 9:00 AM IST.');


// --- Admin API Routes (authenticateToken middleware applied here) ---
app.post('/admin/login', async (req, res) => {
    const { username, password, totpCode } = req.body; // Now expects totpCode

    const admin = await Admin.findOne({ username });

    if (!admin || !await bcrypt.compare(password, admin.password)) {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check if TOTP is enabled for this admin
    if (admin.totpSecret) {
        if (!totpCode) {
            // If TOTP is required but not provided, send a specific error
            return res.status(401).json({ message: 'Two-Factor Authentication code required.' });
        }

        // Verify TOTP code
        const verified = speakeasy.totp.verify({
            secret: admin.totpSecret,
            encoding: 'base32',
            token: totpCode,
            window: 1 // Allow for a small time drift (1 step before or after)
        });

        if (!verified) {
            return res.status(401).json({ message: 'Invalid Two-Factor Authentication code.' });
        }
    } else {
        // If TOTP is not enabled, but a code was sent, it's suspicious or unnecessary
        if (totpCode) {
            console.warn(`TOTP code provided for user ${username} but 2FA is not enabled.`);
            // You might choose to reject here or just ignore it. For now, we'll ignore.
        }
    }

    // If all checks pass, issue JWT token
    const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, twoFactorEnabled: !!admin.totpSecret }); // Inform client if 2FA is enabled
});

app.get('/admin/logout', (req, res) => {
    res.send('Logged out successfully');
});

app.post('/admin/create-initial-admin', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingAdmin = await Admin.findOne({ username });
        if (existingAdmin) {
            return res.status(409).json({ message: 'Admin user already exists.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        // Do NOT generate TOTP secret here. It will be set up via the dashboard.
        const newAdmin = new Admin({ username, password: hashedPassword, totpSecret: null });
        await newAdmin.save();
        res.status(201).json({ message: 'Initial admin user created.' });
    } catch (error) {
        console.error('Error creating initial admin:', error);
        res.status(500).json({ message: 'Error creating initial admin.' });
    }
});

// Authentication Middleware for Admin APIs
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) {
        console.log('Unauthorized: No token provided. (Request to ' + req.path + ')'); // Added path for more context
        return res.status(401).json({ message: 'Unauthorized: No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message, '(Token received for ' + req.path + ')'); // Log the specific JWT error and path
            return res.status(403).json({ message: 'Forbidden: Invalid token.' });
        }
        req.user = user;
        next();
    });
};

// --- 2FA Specific Endpoints ---
app.get('/api/admin/2fa/status', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: req.user.username });
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
        const admin = await Admin.findOne({ username: req.user.username });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }

        // Generate a new secret if one doesn't exist or if forced (e.g., reset)
        let secret;
        if (admin.totpSecret) {
            secret = speakeasy.generateSecret({
                name: `DeliciousBites Admin (${admin.username})`,
                length: 20 // Standard length
            });
            admin.totpSecret = secret.base32;
            await admin.save();
            console.log(`New TOTP secret generated and saved for admin: ${admin.username}`);
        } else {
            secret = speakeasy.generateSecret({
                name: `DeliciousBites Admin (${admin.username})`,
                length: 20
            });
            admin.totpSecret = secret.base32;
            await admin.save();
            console.log(`TOTP secret generated and saved for admin: ${admin.username}`);
        }


        // Generate QR code URL
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
    const { totpCode } = req.body;
    try {
        const admin = await Admin.findOne({ username: req.user.username });
        if (!admin || !admin.totpSecret) {
            return res.status(400).json({ message: '2FA not set up for this user.' });
        }

        const verified = speakeasy.totp.verify({
            secret: admin.totpSecret,
            encoding: 'base32',
            token: totpCode,
            window: 1
        });

        if (verified) {
            res.json({ verified: true, message: '2FA code verified successfully.' });
        } else {
            res.status(401).json({ verified: false, message: 'Invalid 2FA code.' });
        }
    } catch (error) {
        console.error('Error verifying 2FA code:', error);
        res.status(500).json({ message: 'Error verifying 2FA code.' });
    }
});

app.post('/api/admin/2fa/disable', authenticateToken, async (req, res) => {
    try {
        const admin = await Admin.findOne({ username: req.user.username });
        if (!admin) {
            return res.status(404).json({ message: 'Admin user not found.' });
        }
        admin.totpSecret = null; // Disable 2FA
        await admin.save();
        res.json({ message: 'Two-Factor Authentication disabled successfully.' });
    } catch (error) {
        console.error('Error disabling 2FA:', error);
        res.status(500).json({ message: 'Error disabling 2FA.' });
    }
});


app.get('/api/admin/bot-status', authenticateToken, async (req, res) => {
    const settings = await Settings.findOne({});
    res.json({
        status: settings ? settings.whatsappStatus : 'disconnected',
        lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null,
        qrCodeAvailable: qrCodeData !== null
    });
});

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    if (client && (whatsappReady || qrCodeData)) {
         return res.status(400).json({ message: 'WhatsApp client is already connected or QR is active. Please restart if new session is needed.' });
    }
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient(true);
    res.status(200).json({ message: 'Attempting to load saved session.' });
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
            await client.sendMessage(updatedOrder.customerPhone + '@c.us', `Your order (ID: ${updatedOrder._id.substring(0, 6)}...) status has been updated to '${status}'.`);
        }

        res.json({ message: 'Order status updated successfully', order: updatedOrder });
    } catch (error) {
        res.status(400).json({ message: 'Error updating order status', error: error.message });
    }
});

app.delete('/api/admin/orders/:id', authenticateToken, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) return res.status(404).json({ message: 'Order not found' });
        res.json({ message: 'Order deleted successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting order', error: error.message });
    }
});

app.get('/api/admin/customers', authenticateToken, async (req, res) => {
    try {
        const customers = await Customer.find({});
        res.json(customers);
    } catch (error) {
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
            settings = new Settings(); // Create default settings if none exist
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
            return res.status(404).json({ message: 'Settings not found.' });
        }
        res.json({
            shopName: settings.shopName,
            shopLocation: settings.shopLocation,
            deliveryRates: settings.deliveryRates,
        });
    } catch (err) {
        console.error('Error fetching public settings:', err);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
});

app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount, paymentMethod } = req.body;

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        const itemDetails = [];
        for (const item of items) {
            const product = await Item.findById(item.productId);
            if (!product || !product.isAvailable) {
                return res.status(400).json({ message: `Item ${item.name || item.productId} is not available.` });
            }
            itemDetails.push({
                itemId: product._id,
                name: product.name,
                price: product.price,
                quantity: item.quantity,
            });
        }

        const newOrder = new Order({
            items: itemDetails,
            customerName,
            customerPhone,
            deliveryAddress,
            customerLocation,
            subtotal,
            transportTax,
            totalAmount,
            paymentMethod,
            status: 'Pending', // Initial status
        });

        await newOrder.save();

        await Customer.findOneAndUpdate(
            { customerPhone: customerPhone },
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

        if (whatsappReady) {
            io.emit('new_order', newOrder);
            // Send a confirmation message to the user via WhatsApp with a link to track order or next steps
            await client.sendMessage(customerPhone + '@c.us', `Your order (ID: ${newOrder._id.substring(0, 6)}...) has been placed successfully via the web menu! We will notify you of its status updates. You can also view your orders by typing "My Orders".`);
        }

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder._id, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        res.status(500).json({ message: 'Failed to place order.' });
    }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
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
    if (client && (whatsappReady || qrCodeData)) {
        return res.status(400).json({ message: 'WhatsApp client is already connected or QR is active. Please restart if new QR is needed.' });
    }
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient();
    res.status(200).json({ message: 'Requesting new QR code. Check dashboard.' });
});


// --- URL Rewriting / Redirection for .html files ---
app.get('/admin/dashboard.html', (req, res) => res.redirect(301, '/admin/dashboard'));
app.get('/admin/login.html', (req, res) => res.redirect(301, '/admin/login'));
app.get('/menu.html', (req, res) => res.redirect(301, '/menu'));
app.get('/bot_status.html', (req, res) => res.redirect(301, '/'));

// --- HTML Page Routes (Explicitly serve HTML files) ---
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.get('/admin/dashboard', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bot_status.html'));
});

// --- Serve other static assets (CSS, JS, images) ---
app.use(express.static(path.join(__dirname, 'public')));


// Socket.io for real-time updates
io.on('connection', (socket) => {
    console.log('Admin dashboard connected');
    Settings.findOne({}).then(settings => {
        if (settings) {
            socket.emit('status', settings.whatsappStatus);
            socket.emit('sessionInfo', { lastAuthenticatedAt: settings.lastAuthenticatedAt });
        }
    });

    socket.on('disconnect', () => {
        console.log('Admin dashboard disconnected');
    });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin dashboard: http://localhost:${PORT}/admin/login`);
});

