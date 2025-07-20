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

    client.on('qr', async (qr) => {
        console.log('QR RECEIVED');
        qrCodeData = await qrcode.toDataURL(qr);
        qrGeneratedTimestamp = Date.now();
        io.emit('qrCode', qrCodeData);
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_received', lastAuthenticatedAt: null }, { upsert: true });
        io.emit('status', 'qr_received');

        // Set a timer for QR expiry (e.g., 60 seconds)
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        qrExpiryTimer = setTimeout(async () => {
            if (whatsappReady === false && qrCodeData !== null) {
                console.log('QR code expired. Reinitializing...');
                qrCodeData = null; // Clear QR data
                io.emit('qrCode', null); // Notify dashboard QR expired
                await Settings.findOneAndUpdate({}, { whatsappStatus: 'qr_error' }, { upsert: true });
                io.emit('status', 'qr_error');
                initializeWhatsappClient(); // Reinitialize to get a new QR
            }
        }, 60000); // 60 seconds
    });

    client.on('authenticated', async (session) => {
        console.log('AUTHENTICATED');
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'authenticated', lastAuthenticatedAt: new Date() }, { upsert: true });
        io.emit('status', 'authenticated');
        io.emit('sessionInfo', { lastAuthenticatedAt: new Date() });
        qrCodeData = null; // Clear QR data once authenticated
        io.emit('qrCode', null); // Clear QR on dashboard
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
        // Fired if session restore failed
        console.error('AUTHENTICATION FAILURE', msg);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'auth_failure' }, { upsert: true });
        io.emit('status', 'auth_failure');
        qrCodeData = null; // Clear QR data on auth failure
        io.emit('qrCode', null); // Clear QR on dashboard
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
    });

    client.on('disconnected', async (reason) => {
        console.log('Client was disconnected', reason);
        whatsappReady = false;
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'disconnected' }, { upsert: true });
        io.emit('status', 'disconnected');
        qrCodeData = null; // Clear QR data on disconnect
        io.emit('qrCode', null); // Clear QR on dashboard
        if (qrExpiryTimer) clearTimeout(qrExpiryTimer);
        // Attempt to re-initialize client after disconnection
        // If the reason is 'PRIMARY_UNAVAILABLE', it means the phone is offline or WhatsApp is not open.
        // We can choose to re-initialize here or wait for user intervention from admin panel.
        // For now, let's re-initialize to try and get back online.
        if (reason === 'PRIMARY_UNAVAILABLE' || reason === 'UNLAUNCHED') {
             console.log('Reinitializing client due to disconnection...');
             initializeWhatsappClient();
        }
    });

    client.initialize()
        .catch(err => console.error('Client initialization error:', err));
};

// Initial WhatsApp client setup (without loading session explicitly on startup)
// The admin panel will trigger loading session or requesting QR.
// Let's set initial status to 'initializing' on startup if no status is found
(async () => {
    const settings = await Settings.findOne({});
    if (!settings || settings.whatsappStatus === 'disconnected') {
        await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    }
})();


// --- Bot Logic ---

// REMOVED: dryFruitDialoguesTelugu array

const sendWelcomeMessage = async (chatId, customerName) => {
    const menuOptions = [
        "1. 🍕 మెనూ చూడండి",
        "2. 📍 షాప్ లొకేషన్",
        "3. 📞 ఆర్డర్ చేయండి",
        "4. 📝 నా ఆర్డర్స్",
        "5. ℹ️ సహాయం" // Re-numbered
    ];
    const welcomeText = `👋 నమస్తే ${customerName || 'కస్టమర్'}! డెలిషియస్ బైట్స్ కు స్వాగతం! 🌟\n\nమీరు ఎలా సహాయం చేయగలను?\n\n${menuOptions.join('\n')}\n\nపై ఎంపికలలో ఒకదాన్ని ఎంచుకోండి లేదా మీ ఆర్డర్ వివరాలను పంపండి.`;
    await client.sendMessage(chatId, welcomeText);
};

const sendShopLocation = async (chatId) => {
    const settings = await Settings.findOne({});
    if (settings && settings.shopLocation && settings.shopLocation.latitude && settings.shopLocation.longitude) {
        const { latitude, longitude } = settings.shopLocation;
        const googleMapsLink = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
        await client.sendMessage(chatId, `📍 మా షాప్ లొకేషన్ ఇక్కడ ఉంది:\n${googleMapsLink}\n\nత్వరలో మిమ్మల్ని కలవాలని ఆశిస్తున్నాము!`);
    } else {
        await client.sendMessage(chatId, 'క్షమించండి, ప్రస్తుతం షాప్ లొకేషన్ అందుబాటులో లేదు. దయచేసి అడ్మిన్‌ను సంప్రదించండి.');
    }
};

// REMOVED: sendDryFruitTip function

const sendMenu = async (chatId) => {
    const items = await Item.find({ isAvailable: true });
    if (items.length === 0) {
        await client.sendMessage(chatId, 'మెనూలో ప్రస్తుతం ఎటువంటి వస్తువులు లేవు. దయచేసి తర్వాత ప్రయత్నించండి.');
        return;
    }

    let menuMessage = "📜 మా మెనూ:\n\n";
    const categories = {};
    items.forEach(item => {
        const category = item.category || 'ఇతరాలు';
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
    menuMessage += "మీరు ఆర్డర్ చేయడానికి 'ఆర్డర్ చేయండి' అని టైప్ చేయవచ్చు లేదా మెయిన్ మెనూకి తిరిగి వెళ్ళడానికి 'హాయ్' అని టైప్ చేయవచ్చు.";
    await client.sendMessage(chatId, menuMessage);
};

const handleOrderRequest = async (msg) => {
    const chatId = msg.from;
    const customerPhone = chatId.includes('@c.us') ? chatId.split('@')[0] : chatId;

    await client.sendMessage(chatId, 'మీరు ఆర్డర్ చేయాలనుకుంటున్న వస్తువులు మరియు వాటి పరిమాణం (ఉదా: పిజ్జా 1, కోక్ 2) తెలపండి.');
    // Set a flag or context for the customer to indicate they are in ordering mode
    // For simplicity, we'll assume the next message containing item details is the order.
    // In a more complex bot, you'd use session management.
};

const processOrder = async (msg) => {
    const chatId = msg.from;
    const customerPhone = chatId.includes('@c.us') ? chatId.split('@')[0] : chatId;
    const text = msg.body.toLowerCase();

    // Try to parse items from the message
    const availableItems = await Item.find({ isAvailable: true });
    let orderItems = [];
    let subtotal = 0;

    // Simple regex to find "item_name quantity" or "quantity item_name"
    // This is a very basic parser and needs improvement for robustness
    const itemRegex = /(\d+)\s*([a-zA-Z\s]+)|([a-zA-Z\s]+)\s*(\d+)/g;
    let match;

    while ((match = itemRegex.exec(text)) !== null) {
        let quantity, itemNameRaw;
        if (match[1] && match[2]) { // e.g., "2 pizza"
            quantity = parseInt(match[1]);
            itemNameRaw = match[2].trim();
        } else if (match[3] && match[4]) { // e.g., "pizza 2"
            itemNameRaw = match[3].trim();
            quantity = parseInt(match[4]);
        } else {
            continue;
        }

        const foundItem = availableItems.find(item =>
            item.name.toLowerCase().includes(itemNameRaw) ||
            itemNameRaw.includes(item.name.toLowerCase())
        );

        if (foundItem && quantity > 0) {
            orderItems.push({
                itemId: foundItem._id,
                name: foundItem.name,
                price: foundItem.price,
                quantity: quantity
            });
            subtotal += foundItem.price * quantity;
        }
    }

    if (orderItems.length === 0) {
        await client.sendMessage(chatId, 'మీ ఆర్డర్‌లో ఏ వస్తువులను గుర్తించలేకపోయాను. దయచేసి సరైన ఫార్మాట్‌లో మళ్లీ ప్రయత్నించండి (ఉదా: పిజ్జా 1, కోక్ 2).');
        return;
    }

    // --- Delivery Address and Location Prompt ---
    await client.sendMessage(chatId, 'మీ డెలివరీ చిరునామాను (పూర్తి చిరునామా) పంపండి.');
    // Set a temporary flag or context to wait for the address
    // This part requires proper session/context management in a real bot.
    // For this example, we'll simulate by assuming the *next message* is the address.
    // In a real scenario, you'd need a robust state machine or conversation flow.
    await client.sendMessage(chatId, 'డెలివరీ ఖచ్చితంగా ఉండటానికి మీ ప్రస్తుత లొకేషన్‌ను (Google Maps లొకేషన్) కూడా పంపగలరా? ఇది ఐచ్ఛికం కానీ సిఫార్సు చేయబడింది.');

    // Store order items temporarily or in a pending state with customer's phone
    // For now, let's just proceed with a dummy address/location if not received,
    // or assume the next message captures it.
    // **Important:** In a production bot, implement robust state management (e.g., using a database field for 'conversation_state' on the Customer model).
    // For this demonstration, we'll simplify and show the final order confirmation logic.
    // The delivery address and location should ideally be captured in subsequent messages.

    // Calculate transport tax (this would typically happen AFTER location is confirmed)
    let transportTax = 0;
    const settings = await Settings.findOne({});
    if (settings && settings.deliveryRates && settings.deliveryRates.length > 0 && settings.shopLocation) {
        // This is where distance calculation would happen using customerLocation.
        // For now, let's use a placeholder or simplified logic.
        // A robust solution would involve getting the location from the user.
        transportTax = settings.deliveryRates[0] ? settings.deliveryRates[0].amount : 0; // Just use first rate for now
    }
    const totalAmount = subtotal + transportTax;

    // Simulate getting delivery address and location (in a real bot, these would be separate steps)
    const dummyDeliveryAddress = 'చిరునామా ఇంకా అందలేదు.';
    let customerLat = null;
    let customerLon = null;

    // Create a new order object, saving it as "pending_address" or similar
    // This is simplified. In a real app, you'd save a "draft" order and update it.
    const newOrder = new Order({
        customerPhone: customerPhone,
        customerName: msg._data.notifyName || 'Guest', // Get name from WhatsApp
        items: orderItems,
        subtotal: subtotal,
        transportTax: transportTax,
        totalAmount: totalAmount,
        status: 'Pending',
        deliveryAddress: dummyDeliveryAddress, // Will be updated
        customerLocation: {
            latitude: customerLat,
            longitude: customerLon
        }
    });
    await newOrder.save();

    // Confirm order details and ask for payment method
    let confirmationMessage = `మీ ఆర్డర్ వివరాలు:\n\n`;
    orderItems.forEach(item => {
        confirmationMessage += `${item.name} x ${item.quantity} - ₹${(item.price * item.quantity).toFixed(2)}\n`;
    });
    confirmationMessage += `\nఉపమొత్తం: ₹${subtotal.toFixed(2)}\n`;
    confirmationMessage += `డెలివరీ ఛార్జీలు: ₹${transportTax.toFixed(2)}\n`;
    confirmationMessage += `*మొత్తం: ₹${totalAmount.toFixed(2)}*\n\n`;
    confirmationMessage += `మీరు 'క్యాష్ ఆన్ డెలివరీ' (COD) లేదా 'ఆన్‌లైన్ పేమెంట్' (OP) ద్వారా చెల్లించాలనుకుంటున్నారా?`;

    await client.sendMessage(chatId, confirmationMessage);

    // After this, bot would wait for "COD" or "OP" to finalize the order.
    // This also requires state management.
};

const sendCustomerOrders = async (chatId, customerPhone) => {
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(5); // Last 5 orders

    if (orders.length === 0) {
        await client.sendMessage(chatId, 'మీరు గతంలో ఎటువంటి ఆర్డర్లు చేయలేదు.');
        return;
    }

    let orderListMessage = 'మీ గత ఆర్డర్లు:\n\n';
    orders.forEach((order, index) => {
        orderListMessage += `*ఆర్డర్ ${index + 1} (ID: ${order._id.substring(0, 6)}...)*\n`;
        order.items.forEach(item => {
            orderListMessage += `  - ${item.name} x ${item.quantity}\n`;
        });
        orderListMessage += `  మొత్తం: ₹${order.totalAmount.toFixed(2)}\n`;
        orderListMessage += `  స్థితి: ${order.status}\n`;
        orderListMessage += `  తేదీ: ${new Date(order.orderDate).toLocaleDateString('te-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
    });
    await client.sendMessage(chatId, orderListMessage);
};

const sendHelpMessage = async (chatId) => {
    const helpMessage = `ఎలా సహాయం చేయగలను? మీరు ఈ క్రిందివాటిని ప్రయత్నించవచ్చు:\n
*హాయ్* - మెయిన్ మెనూకి తిరిగి వెళ్ళడానికి
*మెనూ చూడండి* - మా అందుబాటులో ఉన్న వస్తువులను చూడటానికి
*ఆర్డర్ చేయండి* - ఆర్డర్ ప్రక్రియను ప్రారంభించడానికి
*నా ఆర్డర్స్* - మీ గత ఆర్డర్‌లను చూడటానికి
*షాప్ లొకేషన్* - మా షాప్ స్థానాన్ని పొందడానికి
*సహాయం* - ఈ సహాయ సందేశాన్ని మళ్లీ చూడటానికి`; // Re-numbered
    await client.sendMessage(chatId, helpMessage);
};


client.on('message', async msg => {
    const chatId = msg.from;
    const text = msg.body.toLowerCase().trim();
    const customerPhone = chatId.includes('@c.us') ? chatId.split('@')[0] : chatId;
    const customerName = msg._data.notifyName;

    // Update customer last known location from message if available
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
        // If an order is pending, associate this location with it
        // (Requires more sophisticated state management for pending orders)
        await client.sendMessage(chatId, 'మీ లొకేషన్ అప్‌డేట్ చేయబడింది. ధన్యవాదాలు!');
        return;
    }


    let customer = await Customer.findOne({ customerPhone: customerPhone });
    if (!customer) {
        customer = new Customer({ customerPhone: customerPhone, customerName: customerName });
        await customer.save();
    } else {
        // Update customer name if it changed (WhatsApp notifyName)
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
        case 'మెనూ': // Main menu trigger
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
        case '5': // Re-numbered
        case 'సహాయం': // Re-numbered
            await sendHelpMessage(chatId);
            break;
        case 'cod':
        case 'cash on delivery':
            // Logic to finalize order with COD
            // This needs to be tied to a pending order
            const pendingOrderCod = await Order.findOneAndUpdate(
                { customerPhone: customerPhone, status: 'Pending' }, // Assuming 'Pending' means awaiting payment confirmation
                { $set: { paymentMethod: 'Cash on Delivery', status: 'Confirmed' } },
                { new: true, sort: { orderDate: -1 } } // Get the most recent pending order
            );
            if (pendingOrderCod) {
                await client.sendMessage(chatId, 'మీ ఆర్డర్ క్యాష్ ఆన్ డెలివరీ కోసం నిర్ధారించబడింది. ధన్యవాదాలు! మీ ఆర్డర్ త్వరలో ప్రాసెస్ చేయబడుతుంది. 😊');
                // Notify admin via socket
                io.emit('new_order', pendingOrderCod);
            } else {
                await client.sendMessage(chatId, 'మీకు పెండింగ్ ఆర్డర్లు ఏమీ లేవు. దయచేసి ముందుగా ఒక ఆర్డర్ చేయండి.');
            }
            break;
        case 'op':
        case 'online payment':
            // Logic to finalize order with Online Payment
            // For now, it's just a placeholder message
            const pendingOrderOp = await Order.findOneAndUpdate(
                { customerPhone: customerPhone, status: 'Pending' },
                { $set: { paymentMethod: 'Online Payment' } }, // Keep status as pending if payment gateway integration is needed
                { new: true, sort: { orderDate: -1 } }
            );
            if (pendingOrderOp) {
                await client.sendMessage(chatId, 'ఆన్‌లైన్ పేమెంట్ ఎంపికను ఎంచుకున్నందుకు ధన్యవాదాలు. పేమెంట్ లింక్ త్వరలో మీకు పంపబడుతుంది. మీ ఆర్డర్ ID: ' + pendingOrderOp._id.substring(0,6) + '...');
                // In a real app, generate and send a payment link here
                io.emit('new_order', pendingOrderOp); // Still notify admin, but payment is pending
            } else {
                await client.sendMessage(chatId, 'మీకు పెండింగ్ ఆర్డర్లు ఏమీ లేవు. దయచేసి ముందుగా ఒక ఆర్డర్ చేయండి.');
            }
            break;
        default:
            // If it's not a recognized command, try to process as an order detail
            // This is a simplified approach. A more robust bot would use context/state.
            // If the user is currently in the "ordering" flow, process this as order items.
            // This needs to be guarded by a proper state machine in production.

            const lastOrderInteraction = await Order.findOne({ customerPhone: customerPhone }).sort({ orderDate: -1 });

            if (lastOrderInteraction && moment().diff(moment(lastOrderInteraction.orderDate), 'minutes') < 5 && lastOrderInteraction.status === 'Pending') {
                 const hasNumbers = /\d/.test(msg.body);
                 const hasItemNames = /(pizza|burger|coke|dosa|idli|మిర్చి|పెరుగు|దోస|ఇడ్లీ)/i.test(msg.body); // Updated keywords
                 if (hasNumbers && hasItemNames) {
                    await processOrder(msg); // Attempt to process as an order
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
    // Set status to initializing before requesting QR
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient(); // This will trigger QR event
    res.status(200).json({ message: 'Requesting new QR code. Check dashboard.' });
});

app.post('/api/admin/load-session', authenticateToken, async (req, res) => {
    if (client && (whatsappReady || qrCodeData)) {
         return res.status(400).json({ message: 'WhatsApp client is already connected or QR is active. Please restart if new session is needed.' });
    }
    await Settings.findOneAndUpdate({}, { whatsappStatus: 'initializing' }, { upsert: true });
    io.emit('status', 'initializing');
    initializeWhatsappClient(true); // Attempt to load saved session
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

        // Notify customer about status update (optional, but good practice)
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
    // Send current bot status on connection
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

