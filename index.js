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

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Middleware for parsing JSON and URL-encoded data
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// JWT Secret (ensure this is in your .env file in production)
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
    },
    lastNotificationSent: { type: Date } // New field for 7-day notification
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
    client.initialize()
        .catch(err => console.error('Client initialization error:', err));
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
        "1. 🍕 మెనూ చూడండి",
        "2. 📍 షాప్ లొకేషన్",
        "3. 📞 ఆర్డర్ చేయండి",
        "4. 📝 నా ఆర్డర్స్",
        "5. ℹ️ సహాయం"
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
};

const processOrder = async (msg) => {
    const chatId = msg.from;
    const customerPhone = chatId.includes('@c.us') ? chatId.split('@')[0] : chatId;
    const text = msg.body.toLowerCase();

    const availableItems = await Item.find({ isAvailable: true });
    let orderItems = [];
    let subtotal = 0;

    const itemRegex = /(\d+)\s*([a-zA-Z\s]+)|([a-zA-Z\s]+)\s*(\d+)/g;
    let match;

    while ((match = itemRegex.exec(text)) !== null) {
        let quantity, itemNameRaw;
        if (match[1] && match[2]) {
            quantity = parseInt(match[1]);
            itemNameRaw = match[2].trim();
        } else if (match[3] && match[4]) {
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

    await client.sendMessage(chatId, 'మీ డెలివరీ చిరునామాను (పూర్తి చిరునామా) పంపండి.');
    await client.sendMessage(chatId, 'డెలివరీ ఖచ్చితంగా ఉండటానికి మీ ప్రస్తుత లొకేషన్‌ను (Google Maps లొకేషన్) కూడా పంపగలరా? ఇది ఐచ్ఛికం కానీ సిఫార్సు చేయబడింది.');

    let transportTax = 0;
    const settings = await Settings.findOne({});
    if (settings && settings.deliveryRates && settings.deliveryRates.length > 0 && settings.shopLocation) {
        transportTax = settings.deliveryRates[0] ? settings.deliveryRates[0].amount : 0;
    }
    const totalAmount = subtotal + transportTax;

    const dummyDeliveryAddress = 'చిరునామా ఇంకా అందలేదు.';
    let customerLat = null;
    let customerLon = null;

    const newOrder = new Order({
        customerPhone: customerPhone,
        customerName: msg._data.notifyName || 'Guest',
        items: orderItems,
        subtotal: subtotal,
        transportTax: transportTax,
        totalAmount: totalAmount,
        status: 'Pending',
        deliveryAddress: dummyDeliveryAddress,
        customerLocation: {
            latitude: customerLat,
            longitude: customerLon
        }
    });
    await newOrder.save();

    let confirmationMessage = `మీ ఆర్డర్ వివరాలు:\n\n`;
    orderItems.forEach(item => {
        confirmationMessage += `${item.name} x ${item.quantity} - ₹${(item.price * item.quantity).toFixed(2)}\n`;
    });
    confirmationMessage += `\nఉపమొత్తం: ₹${subtotal.toFixed(2)}\n`;
    confirmationMessage += `డెలివరీ ఛార్జీలు: ₹${transportTax.toFixed(2)}\n`;
    confirmationMessage += `*మొత్తం: ₹${totalAmount.toFixed(2)}*\n\n`;
    confirmationMessage += `మీరు 'క్యాష్ ఆన్ డెలివరీ' (COD) లేదా 'ఆన్‌లైన్ పేమెంట్' (OP) ద్వారా చెల్లించాలనుకుంటున్నారా?`;

    await client.sendMessage(chatId, confirmationMessage);
};

const sendCustomerOrders = async (chatId, customerPhone) => {
    const orders = await Order.find({ customerPhone: customerPhone }).sort({ orderDate: -1 }).limit(5);

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
*సహాయం* - ఈ సహాయ సందేశాన్ని మళ్లీ చూడటానికి`;
    await client.sendMessage(chatId, helpMessage);
};

// --- New: Fleeting Lines for Re-Order Notifications ---
const reOrderNotificationMessagesTelugu = [
    "మీకు మళ్లీ ఆకలిగా ఉందా? 😋 మా మెనూలో కొత్త రుచులు వేచి ఉన్నాయి! ఇప్పుడే ఆర్డర్ చేయండి! 🚀",
    "మీరు మా రుచికరమైన వంటకాలను కోల్పోతున్నారా? 💖 ఇప్పుడే మీ తదుపరి భోజనాన్ని ఆర్డర్ చేయండి! 🍽️",
    "7 రోజులు గడిచిపోయాయి! ⏳ మళ్లీ ఆర్డర్ చేయడానికి ఇది సరైన సమయం. మీ అభిమాన వంటకాలు సిద్ధంగా ఉన్నాయి! ✨",
    "ప్రత్యేక ఆఫర్! 🎉 ఈ వారం మీ తదుపరి ఆర్డర్‌పై డిస్కౌంట్ పొందండి. మెనూ చూడండి! 📜",
    "మీరు చివరిసారిగా మా నుండి ఆర్డర్ చేసి 7 రోజులు అయ్యింది. మీకు ఇష్టమైనవి మళ్లీ ఆర్డర్ చేయండి! 🧡",
    "ఆకలిగా ఉందా? 🤤 మా డెలిషియస్ బైట్స్ నుండి మీకు ఇష్టమైన భోజనాన్ని ఇప్పుడే ఆర్డర్ చేయండి! 💨",
    "మా మెనూలో కొత్తగా ఏముందో చూడాలనుకుంటున్నారా? 👀 ఇప్పుడే ఆర్డర్ చేసి ప్రయత్నించండి! 🌟",
    "మీరు మా రుచిని మర్చిపోయారా? 😋 మళ్లీ ఆర్డర్ చేయడానికి ఇది సరైన సమయం! 🥳",
    "మీరు ఆర్డర్ చేయాలని ఆలోచిస్తున్నారా? 🤔 ఇది సరైన సూచన! ఇప్పుడే ఆర్డర్ చేయండి! 👇",
    "మీరు చివరిసారిగా ఆర్డర్ చేసినప్పుడు చాలా బాగుంది కదా? 😉 మళ్లీ ఆ అనుభూతిని పొందండి! 💯"
];

// --- New: Scheduled Notification Function ---
const sendReorderNotification = async () => {
    if (!whatsappReady) {
        console.log('WhatsApp client not ready for scheduled notifications.');
        return;
    }

    console.log('Running 7-day re-order notification job...');
    const sevenDaysAgo = moment().subtract(7, 'days').toDate();
    const twoDaysAgo = moment().subtract(2, 'days').toDate(); // Avoid spamming recent customers

    try {
        // Find customers who have ordered at least once,
        // and either haven't received a notification yet OR
        // their last notification was sent more than 7 days ago,
        // AND their last order was NOT within the last 2 days.
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
                await client.sendMessage(chatId, message);
                await Customer.findByIdAndUpdate(customer._id, { lastNotificationSent: new Date() });
                console.log(`Sent re-order notification to ${customer.customerPhone}`);
            } catch (msgSendError) {
                console.error(`Failed to send re-order notification to ${customer.customerPhone}:`, msgSendError);
            }
        }
        console('7-day re-order notification job finished.');

    } catch (dbError) {
        console.error('Error in 7-day re-order notification job (DB query):', dbError);
    }
};

// --- Schedule the 7-day notification job ---
// This cron job will run every day at 09:00 AM (9 AM)
// You can adjust the cron schedule string as needed.
// For testing, you might use '*/1 * * * *' to run every minute.
cron.schedule('0 9 * * *', () => {
    sendReorderNotification();
}, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Set your desired timezone
});
console.log('7-day re-order notification job scheduled to run daily at 9:00 AM IST.');


// --- Admin API Routes (authenticateToken middleware applied here) ---
app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });

    if (admin && await bcrypt.compare(password, admin.password)) {
        const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } else {
        res.status(401).json({ message: 'Invalid credentials' });
    }
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
        const newAdmin = new Admin({ username, password: hashedPassword });
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
    if (token == null) return res.status(401).json({ message: 'Unauthorized: No token provided.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            console.error('JWT Verification Error:', err.message);
            return res.status(403).json({ message: 'Forbidden: Invalid token.' });
        }
        req.user = user;
        next();
    });
};

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
    } catch (error) {
        res.status(400).json({ message: 'Error updating settings', error: error.message });
    }
}
);

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

