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

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
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
    }
});

const AdminSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
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

const initializeWhatsappClient = (loadSession = false) => {
    console.log(`Initializing WhatsApp client (Load session: ${loadSession ? 'Yes' : 'No'})...`);
    if (client) {
        client.destroy().then(() => {
            console.log('Previous client destroyed.');
            client = null;
        }).catch(e => console.error('Error destroying old client:', e));
    }

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'admin', // Use a consistent client ID
            dataPath: path.join(__dirname, '.wwebjs_auth') // Custom path for session data
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true, // Keep headless for production
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
                initializeWhatsappClient();
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
            await client.sendMessage(chatId, 'మీ లొకేషన్ అప్‌డేట్ చేయబడింది. ధన్యవాదాలు!');
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
            case 'నమస్తే':
            case 'హాయ్':
            case 'menu':
            case 'మెనూ':
                await sendWelcomeMessage(chatId, customerName);
                break;
            case '1':
            case 'మెనూ చూడండి':
                await sendMenu(chatId);
                break;
            case '2':
            case 'షాప్ లొకేషన్':
                await sendShopLocation(chatId);
                break;
            case '3':
            case 'ఆర్డర్ చేయండి':
                await handleOrderRequest(msg);
                break;
            case '4':
            case 'నా ఆర్డర్స్':
                await sendCustomerOrders(chatId, customerPhone);
                break;
            case '5':
            case 'సహాయం':
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
                    await client.sendMessage(chatId, 'మీ ఆర్డర్ క్యాష్ ఆన్ డెలివరీ కోసం నిర్ధారించబడింది. ధన్యవాదాలు! మీ ఆర్డర్ త్వరలో ప్రాసెస్ చేయబడుతుంది. 😊');
                    io.emit('new_order', pendingOrderCod);
                } else {
                    await client.sendMessage(chatId, 'మీకు పెండింగ్ ఆర్డర్లు ఏమీ లేవు. దయచేసి ముందుగా ఒక ఆర్డర్ చేయండి.');
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
                    await client.sendMessage(chatId, 'ఆన్‌లైన్ పేమెంట్ ఎంపికను ఎంచుకున్నందుకు ధన్యవాదాలు. పేమెంట్ లింక్ త్వరలో మీకు పంపబడుతుంది. మీ ఆర్డర్ ID: ' + pendingOrderOp._id.substring(0,6) + '...');
                    io.emit('new_order', pendingOrderOp);
                } else {
                    await client.sendMessage(chatId, 'మీకు పెండింగ్ ఆర్డర్లు ఏమీ లేవు. దయచేసి ముందుగా ఒక ఆర్డర్ చేయండి.');
                }
                break;
            default:
                const lastOrderInteraction = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });

                if (lastOrderInteraction && moment().diff(moment(lastOrderInteraction.orderDate), 'minutes') < 5 && lastOrderInteraction.status === 'Pending') {
                     const hasNumbers = /\d/.test(msg.body);
                     const hasItemNames = /(pizza|burger|coke|dosa|idli|మిర్చి|పెరుగు|దోస|ఇడ్లీ)/i.test(msg.body);
                     if (hasNumbers && hasItemNames) {
                        await processOrder(msg);
                     } else if (!lastOrderInteraction.deliveryAddress || lastOrderInteraction.deliveryAddress === 'చిరునామా ఇంకా అందలేదు.') {
                        await Order.findOneAndUpdate(
                            { _id: lastOrderInteraction._id },
                            { $set: { deliveryAddress: msg.body } },
                            { new: true }
                        );
                        await client.sendMessage(chatId, 'మీ డెలివరీ చిరునామా సేవ్ చేయబడింది. దయచేసి మీ పేమెంట్ పద్ధతిని ఎంచుకోండి: ' +
                                                  "'క్యాష్ ఆన్ డెలివరీ' (COD) లేదా 'ఆన్‌లైన్ పేమెంట్' (OP).");
                     } else {
                         await client.sendMessage(chatId, 'మీరు అడిగినది నాకు అర్థం కాలేదు. దయచేసి మెయిన్ మెనూకి తిరిగి వెళ్ళడానికి "హాయ్" అని టైప్ చేయండి లేదా "సహాయం" కోసం అడగండి.');
                     }
                } else {
                     await client.sendMessage(chatId, 'మీరు అడిగినది నాకు అర్థం కాలేదు. దయచేసి మెయిన్ మెనూకి తిరిగి వెళ్ళడానికి "హాయ్" అని టైప్ చేయండి లేదా "సహాయం" కోసం అడగండి.');
                }
                break;
        }
    });
    // --- End of client.on() listeners ---

    client.initialize()
        .catch(err => console.error('Client initialization error:', err));
};

// Initial WhatsApp client setup (without loading session explicitly on startup)
(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected') {
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    }
    // Call initializeWhatsappClient here to ensure it runs when the server starts
    initializeWhatsappClient();
})();


// --- Admin API Routes ---

// Authentication Middleware for Admin
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// Admin Login
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });

    if (admin && await bcrypt.compare(password, admin.password)) {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } else {
        res.status(401).send('Invalid credentials');
    }
});

// Admin Dashboard Page
app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
});

// Admin Login Page
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

// Logout (client-side handles token removal)
app.get('/admin/logout', (req, res) => {
    res.send('Logged out successfully'); // Client-side will clear token
});

// API to create an initial admin user (for setup)
app.post('/admin/create-initial-admin', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existingAdmin = await Admin.findOne({ username });
        if (existingAdmin) {
            return res.status(409).send('Admin user already exists.');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newAdmin = new Admin({ username, password: hashedPassword });
        await newAdmin.save();
        res.status(201).send('Initial admin user created.');
    } catch (error) {
        console.error('Error creating initial admin:', error);
        res.status(500).send('Error creating initial admin.');
    }
});

// --- WhatsApp Bot Status API ---
app.get('/api/admin/bot-status', authenticateToken, async (req, res) => {
    const settings = await Settings.findOne({});
    res.json({
        status: settings ? settings.whatsappStatus : 'disconnected',
        lastAuthenticatedAt: settings ? settings.lastAuthenticatedAt : null,
        qrCodeAvailable: qrCodeData !== null // Inform if QR is available
    });
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

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    if (client && (whatsappReady || qrCodeData)) {
         return res.status(400).json({ message: 'WhatsApp client is already connected or QR is active. Please restart if new session is needed.' });
    }
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient(true);
    res.status(200).json({ message: 'Attempting to load saved session.' });
});


// --- Menu Management API ---
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
    } catch (error) {
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

// --- Order Management API ---
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
            await client.sendMessage(updatedOrder.customerPhone + '@c.us', `మీ ఆర్డర్ (ID: ${updatedOrder._id.substring(0, 6)}...) స్థితి '${status}' కు అప్‌డేట్ చేయబడింది.`);
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

// --- Customer Management API ---
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

// --- Settings API ---
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
    } catch (error) {
        res.status(400).json({ message: 'Error updating settings', error: error.message });
    }
});


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

