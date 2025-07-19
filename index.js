require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const mongoose = require('mongoose');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// Mongoose Schemas and Models
const OrderSchema = new mongoose.Schema({
    items: [{
        productId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', required: true },
        name: String,
        price: Number,
        quantity: Number,
    }],
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true }, // E.g., 918897350151
    deliveryAddress: { type: String, required: true },
    customerLocation: { // Store customer's last known coordinates
        latitude: Number,
        longitude: Number
    },
    subtotal: { type: Number, required: true },
    transportTax: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },
    paymentMethod: { type: String, default: 'COD' },
    status: { type: String, default: 'Pending' }, // Pending, Confirmed, Preparing, Out for Delivery, Delivered, Cancelled
    orderDate: { type: Date, default: Date.now },
});

const MenuItemSchema = new mongoose.Schema({
    name: { type: String, required: true },
    description: String,
    price: { type: Number, required: true },
    imageUrl: String,
    category: String,
    isAvailable: { type: Boolean, default: true },
    isTrending: { type: Boolean, default: false },
});

const SettingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'Delicious Bites' },
    shopLocation: { // Shop's coordinates
        latitude: { type: Number, default: 0 },
        longitude: { type: Number, default: 0 }
    },
    deliveryRates: [{ // { kms: Number, amount: Number }
        kms: Number,
        amount: Number
    }],
    adminUsername: { type: String, required: true, unique: true },
    adminPassword: { type: String, required: true },
});

const CustomerSchema = new mongoose.Schema({
    customerPhone: { type: String, required: true, unique: true },
    customerName: { type: String },
    lastKnownLocation: { // Last known coordinates of the customer
        latitude: Number,
        longitude: Number
    },
    totalOrders: { type: Number, default: 0 },
    lastOrderDate: { type: Date }
});

// New Session Schema
const WhatsappSessionSchema = new mongoose.Schema({
    sessionData: Object, // The session object from whatsapp-web.js
    lastAuthenticatedAt: { type: Date, default: Date.now }, // Timestamp of last successful authentication
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

const Order = mongoose.model('Order', OrderSchema);
const MenuItem = mongoose.model('MenuItem', MenuItemSchema);
const Setting = mongoose.model('Setting', SettingsSchema);
const Customer = mongoose.model('Customer', CustomerSchema);
const WhatsappSession = mongoose.model('WhatsappSession', WhatsappSessionSchema);

// Admin User setup
async function setupAdminUser() {
    try {
        let settings = await Setting.findOne();
        if (!settings) {
            console.log('No settings found, creating default admin user...');
            const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
            settings = new Setting({
                shopName: 'Delicious Bites',
                shopLocation: { latitude: 0, longitude: 0 },
                deliveryRates: [],
                adminUsername: process.env.ADMIN_USERNAME,
                adminPassword: hashedPassword,
            });
            await settings.save();
            console.log('Default admin user created.');
        } else {
            // Optional: Update admin credentials if env vars change and if not already hashed
            // This logic can be more sophisticated in production, e.g., only on first boot
            if (!bcrypt.getRounds(settings.adminPassword)) { // Check if password is not hashed
                 const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
                 settings.adminPassword = hashedPassword;
                 await settings.save();
                 console.log('Admin password re-hashed based on .env.');
            }
        }
    } catch (err) {
        console.error('Error setting up admin user:', err);
    }
}
setupAdminUser(); // Call on startup

// Express Session Middleware
const store = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 14 * 24 * 60 * 60, // 14 days
    autoRemove: 'interval',
    autoRemoveInterval: 10, // In minutes. Every 10 minutes, the database is scanned for expired sessions.
});

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
        secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
        httpOnly: true,
    }
}));

// Authentication Middleware
const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.status(401).send('Unauthorized');
    }
};


app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


// WhatsApp Client Initialization
let client;
let botStatus = 'initializing';
let lastAuthenticatedAt = null; // To store the timestamp of last successful authentication

async function initializeBot() {
    console.log('Initializing WhatsApp bot...');
    io.emit('status', 'initializing');
    botStatus = 'initializing';

    let loadedSession;
    try {
        const latestSession = await WhatsappSession.findOne().sort({ updatedAt: -1 });
        if (latestSession && latestSession.sessionData) {
            loadedSession = latestSession.sessionData;
            console.log('Loaded session from database.');
        } else {
            console.log('No saved session found in database. Starting fresh.');
        }
    } catch (dbErr) {
        console.error('Error loading session from DB:', dbErr);
        console.warn('Proceeding without loading a saved session.');
    }

    // Initialize client with loaded session if available
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: "bot-client", // LocalAuth persists session to disk, but we also save to DB
            dataPath: './.wwebjs_auth/' // Path to store local session files
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
        session: loadedSession // Pass the loaded session object if available
    });

    client.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        io.emit('qrCode', qr);
        io.emit('status', 'qr_received');
        botStatus = 'qr_received';
        lastAuthenticatedAt = null; // Reset on new QR
    });

    client.on('authenticated', async (session) => {
        console.log('AUTHENTICATED', session);
        io.emit('status', 'authenticated');
        botStatus = 'authenticated';
        lastAuthenticatedAt = new Date(); // Set timestamp on authentication

        // Save/Update session data in MongoDB
        try {
            await WhatsappSession.findOneAndUpdate(
                {}, // Find any existing session (assuming one bot instance)
                { sessionData: session, lastAuthenticatedAt: lastAuthenticatedAt, updatedAt: new Date() },
                { upsert: true, new: true } // Create if not exists, return new doc
            );
            console.log('Session data saved to MongoDB.');
        } catch (dbErr) {
            console.error('Error saving session to MongoDB:', dbErr);
        }
    });

    client.on('auth_failure', async msg => {
        console.error('AUTHENTICATION FAILURE', msg);
        io.emit('status', 'auth_failure');
        botStatus = 'auth_failure';
        lastAuthenticatedAt = null; // Reset on failure
        // Optionally, delete the stored session if it's permanently invalid
        try {
            await WhatsappSession.deleteMany({}); // Or find and delete specific one
            console.log('Authentication failed, cleared session data from MongoDB.');
        } catch (dbErr) {
            console.error('Error clearing session from MongoDB on auth failure:', dbErr);
        }
    });

    client.on('ready', () => {
        console.log('WhatsApp Client is ready!');
        io.emit('status', 'ready');
        botStatus = 'ready';
        lastAuthenticatedAt = new Date(); // Update timestamp on ready

        // Update lastUsedAt in DB for the active session
        WhatsappSession.findOneAndUpdate(
            { sessionData: { $ne: null } }, // Find an existing session
            { lastAuthenticatedAt: lastAuthenticatedAt, updatedAt: new Date() },
            { new: true }
        ).catch(dbErr => console.error('Error updating session lastUsedAt:', dbErr));

        // Initial fetch of settings to get shopLocation for distance calculation
        Setting.findOne().then(settings => {
            if (settings && settings.shopLocation) {
                shopLocationData = settings.shopLocation;
            }
        }).catch(err => console.error('Error fetching settings on bot ready:', err));
    });

    client.on('disconnected', async (reason) => {
        console.log('WhatsApp Client was disconnected:', reason);
        io.emit('status', 'disconnected');
        botStatus = 'disconnected';
        lastAuthenticatedAt = null; // Reset on disconnect
        // Optionally, handle specific reasons to clear session or attempt reconnect
        // For now, if disconnected, client will try to initialize again on next request or server restart
        // client.destroy(); // Destroy current client instance
        // initializeBot(); // Attempt to re-initialize
    });

    client.on('message', async msg => {
        console.log('MESSAGE RECEIVED', msg.body);

        if (msg.body === '!menu') {
            const menuLink = `${process.env.YOUR_KOYEB_URL}/menu`;
            await client.sendMessage(msg.from, `Welcome to Delicious Bites! 🍽️\n\nCheck out our full menu here: ${menuLink}\n\nTo place an order, simply add items to your cart on the menu page and proceed to checkout.`);
        } else if (msg.body === '!status') {
            // Placeholder for order status check
            await client.sendMessage(msg.from, 'To check your order status, please visit the order tracking page on our website after placing an order.');
        }
    });

    client.initialize()
        .catch(err => console.error('Client initialization failed:', err));
}

// Global variable to store shop location data for distance calculation
let shopLocationData = null;

// Periodically fetch settings to keep shopLocationData updated
setInterval(async () => {
    try {
        const settings = await Setting.findOne();
        if (settings && settings.shopLocation) {
            shopLocationData = settings.shopLocation;
        }
    } catch (err) {
        console.error('Error fetching settings periodically:', err);
    }
}, 60000); // Every 1 minute

// Public Routes (Accessible by customers)
app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// Serve the bot status page at the root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bot_status.html'));
});

// API for menu items (public)
app.get('/api/menu', async (req, res) => {
    try {
        const menuItems = await MenuItem.find({ isAvailable: true });
        res.json(menuItems);
    } catch (err) {
        console.error('Error fetching public menu items:', err);
        res.status(500).json({ message: 'Failed to fetch menu items.' });
    }
});

// API for public settings (e.g., shop location, delivery rates)
app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await Setting.findOne();
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

// API for placing an order (public)
app.post('/api/order', async (req, res) => {
    try {
        const { items, customerName, customerPhone, deliveryAddress, customerLocation, subtotal, transportTax, totalAmount, paymentMethod } = req.body;

        if (!items || items.length === 0 || !customerName || !customerPhone || !deliveryAddress || !totalAmount) {
            return res.status(400).json({ message: 'Missing required order details.' });
        }

        // Validate items and retrieve full product details for storing
        const itemDetails = [];
        for (const item of items) {
            const product = await MenuItem.findById(item.productId);
            if (!product || !product.isAvailable) {
                return res.status(400).json({ message: `Item ${item.name || item.productId} is not available.` });
            }
            itemDetails.push({
                productId: product._id,
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
            customerLocation, // Save customer's location
            subtotal,
            transportTax,
            totalAmount,
            paymentMethod,
            status: 'Pending',
        });

        await newOrder.save();

        // Update/Create Customer record
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
            { upsert: true, new: true } // Create if not exists, return new doc
        );


        // Notify admin via WhatsApp (if bot is ready)
        if (botStatus === 'ready' && process.env.ADMIN_NUMBER) {
            const adminNumber = process.env.ADMIN_NUMBER; // Ensure this is a valid WhatsApp number
            let orderSummary = `*New Order Received!* 🎉\n\n*Order ID:* ${newOrder._id.toString().substring(0, 8)}\n*Customer:* ${customerName}\n*Phone:* ${customerPhone}\n*Address:* ${deliveryAddress}\n`;
            if (customerLocation && customerLocation.latitude && customerLocation.longitude) {
                orderSummary += `*Location:* http://www.google.com/maps/place/${customerLocation.latitude},${customerLocation.longitude}\n`;
            }
            orderSummary += `*Payment:* ${paymentMethod}\n\n*Items:*\n`;
            itemDetails.forEach(item => {
                orderSummary += `- ${item.name} x ${item.quantity} (₹${item.price.toFixed(2)} each)\n`;
            });
            orderSummary += `\n*Subtotal:* ₹${subtotal.toFixed(2)}\n*Transport Tax:* ₹${transportTax.toFixed(2)}\n*Total:* ₹${totalAmount.toFixed(2)}\n\n`;
            orderSummary += `Manage this order: ${process.env.YOUR_KOYEB_URL}/admin/dashboard`;

            try {
                await client.sendMessage(`${adminNumber}@c.us`, orderSummary);
                console.log(`Admin notified for order ${newOrder._id}`);
            } catch (waError) {
                console.error('Error sending WhatsApp notification to admin:', waError);
            }
        } else {
            console.warn('WhatsApp bot not ready or ADMIN_NUMBER not set. Admin not notified.');
        }

        res.status(201).json({ message: 'Order placed successfully!', orderId: newOrder._id, order: newOrder });

    } catch (err) {
        console.error('Error placing order:', err);
        res.status(500).json({ message: 'Failed to place order.' });
    }
});

// API to get single order status (public for tracking)
app.get('/api/order/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({
            orderId: order._id,
            status: order.status,
            orderDate: order.orderDate,
            totalAmount: order.totalAmount,
            // Include other details necessary for public tracking if desired
        });
    } catch (err) {
        console.error('Error fetching order status:', err);
        res.status(500).json({ message: 'Failed to fetch order status.' });
    }
});

// Admin Routes
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const settings = await Setting.findOne();
        if (!settings) {
            return res.status(500).json({ message: 'Admin settings not configured.' });
        }

        const isPasswordValid = await bcrypt.compare(password, settings.adminPassword);

        if (username === settings.adminUsername && isPasswordValid) {
            req.session.isAuthenticated = true;
            return res.json({ success: true, message: 'Login successful!' });
        } else {
            return res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'An error occurred during login.' });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out.' });
        }
        res.redirect('/admin/login');
    });
});

app.get('/admin/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
});

// Admin API for bot status (emits to Socket.IO, frontend consumes)
app.get('/api/admin/bot-status', isAuthenticated, (req, res) => {
    // This endpoint primarily serves to allow the frontend to trigger a status update fetch,
    // though the real-time updates happen via socket.io.
    io.emit('status', botStatus); // Emit current status to all connected clients
    if (botStatus === 'qr_received' && client && client.qr) {
        io.emit('qrCode', client.qr);
    }
    io.emit('sessionInfo', { lastAuthenticatedAt: lastAuthenticatedAt }); // Emit session timestamp
    res.json({ status: botStatus, lastAuthenticatedAt: lastAuthenticatedAt });
});

// Admin API to request new QR (via backend trigger)
app.post('/api/public/request-qr', async (req, res) => {
    try {
        if (client) {
            await client.destroy(); // Destroy existing session
            console.log('Client destroyed. Requesting new QR.');
        }
        initializeBot(); // Re-initialize to get a new QR
        res.json({ message: 'New QR request initiated. Check status panel for QR.' });
    } catch (error) {
        console.error('Error requesting new QR:', error);
        res.status(500).json({ message: 'Failed to request new QR.' });
    }
});

// Admin API to load saved session
app.post('/api/admin/load-session', isAuthenticated, async (req, res) => {
    try {
        if (client) {
            await client.destroy(); // Destroy current client to allow new session load
        }
        await initializeBot(); // Re-initialize, which will attempt to load from DB
        res.json({ message: 'Attempting to load saved session. Check status panel.' });
    } catch (error) {
        console.error('Error loading saved session:', error);
        res.status(500).json({ message: 'Failed to load saved session.' });
    }
});


// Admin API for Orders
app.get('/api/admin/orders', isAuthenticated, async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ message: 'Failed to fetch orders.' });
    }
});

app.get('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json(order);
    } catch (err) {
        console.error('Error fetching single order:', err);
        res.status(500).json({ message: 'Failed to fetch order.' });
    }
});

app.put('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const { status } = req.body;
        const updatedOrder = await Order.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true }
        );
        if (!updatedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        // Notify customer (if bot is ready and order status changes significantly)
        if (botStatus === 'ready' && updatedOrder.customerPhone) {
            let customerMessage = `Hello ${updatedOrder.customerName || 'customer'}! Your order *${updatedOrder._id.toString().substring(0, 8)}* status has been updated to: *${updatedOrder.status}*`;
            if (updatedOrder.status === 'Out for Delivery') {
                customerMessage += '\n\nYour delicious meal is on its way! 🛵💨';
                if (shopLocationData && shopLocationData.latitude && shopLocationData.longitude && updatedOrder.customerLocation && updatedOrder.customerLocation.latitude) {
                     customerMessage += `\nTrack your order: ${process.env.YOUR_KOYEB_URL}/track?orderId=${updatedOrder._id}`;
                }
            } else if (updatedOrder.status === 'Delivered') {
                customerMessage += '\n\nYour order has been delivered! Enjoy your meal. 😊';
            } else if (updatedOrder.status === 'Cancelled') {
                customerMessage += '\n\nWe apologize, your order has been cancelled. Please contact us for more details.';
            }
             try {
                await client.sendMessage(`${updatedOrder.customerPhone}@c.us`, customerMessage);
                console.log(`Customer ${updatedOrder.customerPhone} notified of status update.`);
            } catch (waError) {
                console.error('Error sending WhatsApp notification to customer:', waError);
            }
        }
        res.json(updatedOrder);
    } catch (err) {
        console.error('Error updating order status:', err);
        res.status(500).json({ message: 'Failed to update order status.' });
    }
});

app.delete('/api/admin/orders/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({ message: 'Order deleted successfully.' });
    } catch (err) {
        console.error('Error deleting order:', err);
        res.status(500).json({ message: 'Failed to delete order.' });
    }
});

// Admin API for Menu Items
app.get('/api/admin/menu', isAuthenticated, async (req, res) => {
    try {
        const menuItems = await MenuItem.find();
        res.json(menuItems);
    } catch (err) {
        console.error('Error fetching menu items:', err);
        res.status(500).json({ message: 'Failed to fetch menu items.' });
    }
});

app.get('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const menuItem = await MenuItem.findById(req.params.id);
        if (!menuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json(menuItem);
    } catch (err) {
        console.error('Error fetching single menu item:', err);
        res.status(500).json({ message: 'Failed to fetch menu item.' });
    }
});

app.post('/api/admin/menu', isAuthenticated, async (req, res) => {
    try {
        const newMenuItem = new MenuItem(req.body);
        await newMenuItem.save();
        res.status(201).json(newMenuItem);
    } catch (err) {
        console.error('Error creating menu item:', err);
        res.status(500).json({ message: 'Failed to create menu item.' });
    }
});

app.put('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const updatedMenuItem = await MenuItem.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        if (!updatedMenuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json(updatedMenuItem);
    } catch (err) {
        console.error('Error updating menu item:', err);
        res.status(500).json({ message: 'Failed to update menu item.' });
    }
});

app.delete('/api/admin/menu/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedMenuItem = await MenuItem.findByIdAndDelete(req.params.id);
        if (!deletedMenuItem) {
            return res.status(404).json({ message: 'Menu item not found.' });
        }
        res.json({ message: 'Menu item deleted successfully.' });
    } catch (err) {
        console.error('Error deleting menu item:', err);
        res.status(500).json({ message: 'Failed to delete menu item.' });
    }
});

// Admin API for Shop Settings
app.get('/api/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const settings = await Setting.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found.' });
        }
        // Exclude password hash from response
        const { adminPassword, ...safeSettings } = settings.toObject();
        res.json(safeSettings);
    } catch (err) {
        console.error('Error fetching settings:', err);
        res.status(500).json({ message: 'Failed to fetch settings.' });
    }
});

app.put('/api/admin/settings', isAuthenticated, async (req, res) => {
    try {
        const { shopName, shopLocation, deliveryRates, adminUsername, adminPassword } = req.body;

        let settings = await Setting.findOne();
        if (!settings) {
            return res.status(404).json({ message: 'Settings not found. Please create defaults first.' });
        }

        settings.shopName = shopName || settings.shopName;
        settings.shopLocation = shopLocation || settings.shopLocation;
        settings.deliveryRates = deliveryRates || settings.deliveryRates;

        if (adminUsername && adminUsername !== settings.adminUsername) {
            settings.adminUsername = adminUsername;
        }
        if (adminPassword) { // Only update password if provided
            settings.adminPassword = await bcrypt.hash(adminPassword, 10);
        }

        await settings.save();
        // Update the global shopLocationData immediately
        shopLocationData = settings.shopLocation;
        const { adminPassword: _, ...safeSettings } = settings.toObject(); // Exclude password hash
        res.json({ message: 'Settings updated successfully!', ...safeSettings });
    } catch (err) {
        console.error('Error updating settings:', err);
        res.status(500).json({ message: 'Failed to update settings.' });
    }
});


// Admin API for Customers (including last known location)
app.get('/api/admin/customers', isAuthenticated, async (req, res) => {
    try {
        const customers = await Customer.find().sort({ lastOrderDate: -1 });
        res.json(customers);
    } catch (err) {
        console.error('Error fetching customers:', err);
        res.status(500).json({ message: 'Failed to fetch customer data.' });
    }
});

app.delete('/api/admin/customers/:id', isAuthenticated, async (req, res) => {
    try {
        const deletedCustomer = await Customer.findByIdAndDelete(req.params.id);
        if (!deletedCustomer) {
            return res.status(404).json({ message: 'Customer not found.' });
        }
        res.json({ message: 'Customer deleted successfully.' });
    } catch (err) {
        console.error('Error deleting customer:', err);
        res.status(500).json({ message: 'Failed to delete customer.' });
    }
});

// Socket.IO connection
io.on('connection', (socket) => {
    console.log('A user connected via Socket.IO');
    // Send current status to newly connected client
    socket.emit('status', botStatus);
    if (botStatus === 'qr_received' && client && client.qr) {
        socket.emit('qrCode', client.qr);
    }
    socket.emit('sessionInfo', { lastAuthenticatedAt: lastAuthenticatedAt });

    socket.on('disconnect', () => {
        console.log('User disconnected from Socket.IO');
    });
});

// Start the bot client on server start
initializeBot();

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Access Admin Dashboard: ${process.env.YOUR_KOYEB_URL}/admin/dashboard`);
    console.log(`View Public Menu: ${process.env.YOUR_KOYEB_URL}/menu`);
    console.log(`View Bot Status: ${process.env.YOUR_KOYEB_URL}/`);
});

