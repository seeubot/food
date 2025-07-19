// Removed: require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs'); // Still included for now, but its .env check will be removed
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const http = require('http');
const socketIo = require('socket.io');

// Import Mongoose Models
const Order = require('./models/order');
const MenuItem = require('./models/menuItem');
const Customer = require('./models/customer');
const Settings = require('./models/settings');
const Admin = require('./models/admin');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// --- HARDCODED CREDENTIALS (TEMPORARY SOLUTION) ---
// REPLACE THESE WITH YOUR ACTUAL MONGODB URI AND JWT SECRET
// For debugging purposes, using the placeholder from your .env file
const MONGODB_URI = "mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room";
const JWT_SECRET = "your_super_secret_jwt_key_here_please_change_this";
// --- END HARDCODED CREDENTIALS ---


// Removed: All previous diagnostic logs and FATAL ERROR checks for MONGODB_URI and JWT_SECRET
// Removed: .env file presence check using fs module

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Connection
mongoose.connect(MONGODB_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => {
        console.error('MongoDB connection error:', err);
        // For now, we won't exit, but log the error clearly.
    });

// WhatsApp Client Initialization (rest of the logic remains the same)
let whatsappClient;
let qrCodeData = null;
let whatsappStatus = 'initializing';

function updateBotStatus(status, data = null) {
    whatsappStatus = status;
    io.emit('status', status);
    if (status === 'qr_received' && data) {
        qrCodeData = data;
        io.emit('qrCode', data);
    } else if (status === 'ready' || status === 'disconnected' || status === 'auth_failure') {
        qrCodeData = null;
        io.emit('qrCode', null);
    }
    console.log(`WhatsApp Bot Status: ${status}`);
}

async function initializeWhatsAppClient(loadSession = true) {
    if (whatsappClient) {
        await whatsappClient.destroy().catch(e => console.error("Error destroying old client:", e));
        whatsappClient = null;
    }

    updateBotStatus('initializing');
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot',
            dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    whatsappClient.on('qr', async (qr) => {
        qrcode.toDataURL(qr, { small: false }, (err, url) => {
            if (err) {
                console.error('Error generating QR code data URL:', err);
                updateBotStatus('qr_error');
            } else {
                updateBotStatus('qr_received', url);
            }
        });
    });

    whatsappClient.on('ready', () => {
        updateBotStatus('ready');
        console.log('WhatsApp Client is ready!');
    });

    whatsappClient.on('authenticated', () => {
        updateBotStatus('authenticated');
        console.log('WhatsApp Client is authenticated!');
    });

    whatsappClient.on('auth_failure', msg => {
        updateBotStatus('auth_failure');
        console.error('AUTHENTICATION FAILURE', msg);
    });

    whatsappClient.on('disconnected', (reason) => {
        updateBotStatus('disconnected');
        console.log('WhatsApp Client was disconnected', reason);
        setTimeout(() => {
            if (whatsappStatus !== 'ready' && whatsappStatus !== 'initializing') {
                console.log('Attempting to reinitialize after disconnection...');
                initializeWhatsAppClient(true);
            }
        }, 5000);
    });

    whatsappClient.on('change_state', state => {
        console.log('Connection State Change:', state);
        if (state === 'CONNECTED') {
            updateBotStatus('ready');
        } else if (state === 'DISCONNECTED') {
            updateBotStatus('disconnected');
        } else {
            updateBotStatus(state);
        }
    });

    whatsappClient.on('message', async message => {
        console.log('Message received:', message.body);

        let customer = await Customer.findOne({ customerPhone: message.from });
        if (!customer) {
            customer = new Customer({
                customerPhone: message.from,
                customerName: message._data.notifyName || 'Customer'
            });
            await customer.save();
        } else {
            if (customer.customerName === 'Customer' && message._data.notifyName) {
                customer.customerName = message._data.notifyName;
                await customer.save();
            }
        }

        const settings = await Settings.findOne({});
        const shopName = settings ? settings.shopName : 'Our Shop';

        const lowerCaseMessage = message.body.toLowerCase().trim();

        if (lowerCaseMessage === 'hi' || lowerCaseMessage === 'hello' || lowerCaseMessage === 'start') {
            const welcomeMessage = `Hello from ${shopName}! 😊\n\nHow can I help you today? You can try:\n\n*1. Order Food* 🍔\n*2. View Menu* 📜\n*3. My Orders* 📦\n*4. Shop Location* 📍\n*5. Contact Us* 📞`;
            message.reply(welcomeMessage);
        } else if (lowerCaseMessage === '1' || lowerCaseMessage.includes('order food')) {
            const menuItems = await MenuItem.find({ isAvailable: true });
            if (menuItems.length > 0) {
                let menuText = `*${shopName} Menu:*\n\n`;
                menuItems.forEach((item, index) => {
                    menuText += `${index + 1}. *${item.name}* - ₹${item.price.toFixed(2)}\n`;
                    if (item.description) {
                        menuText += `   _${item.description}_\n`;
                    }
                    if (item.isTrending) {
                        menuText += `   _🔥 Trending_ \n`;
                    }
                    menuText += '\n';
                });
                menuText += 'To order, please send the *item name(s) and quantity*, e.g., "Burger x2, Pizza x1".\n\nOr reply with *Cancel Order* to abort.';
                message.reply(menuText);
            } else {
                message.reply('Sorry, our menu is currently empty. Please check back later!');
            }
        } else if (lowerCaseMessage === '2' || lowerCaseMessage.includes('view menu')) {
            const menuItems = await MenuItem.find({ isAvailable: true });
            if (menuItems.length > 0) {
                let menuText = `*${shopName} Menu:*\n\n`;
                menuItems.forEach((item, index) => {
                    menuText += `${index + 1}. *${item.name}* - ₹${item.price.toFixed(2)}\n`;
                    if (item.description) {
                        menuText += `   _${item.description}_\n`;
                    }
                    if (item.isTrending) {
                        menuText += `   _🔥 Trending_ \n`;
                    }
                    menuText += '\n';
                });
                menuText += 'You can order by sending the *item name(s) and quantity*, e.g., "Burger x2, Pizza x1".';
                message.reply(menuText);
            } else {
                message.reply('Sorry, our menu is currently empty. Please check back later!');
            }
        } else if (lowerCaseMessage === '3' || lowerCaseMessage.includes('my orders')) {
            const customerPhone = message.from;
            const orders = await Order.find({ customerPhone }).sort({ orderDate: -1 }).limit(5);

            if (orders.length === 0) {
                message.reply('You have no recent orders. Why not place one now?');
                return;
            }

            let ordersSummary = `*Your Recent Orders:*\n\n`;
            for (const order of orders) {
                ordersSummary += `*Order ID:* ${order._id.toString().substring(0, 8)}...\n`;
                ordersSummary += `*Status:* ${order.status}\n`;
                ordersSummary += `*Total:* ₹${order.totalAmount.toFixed(2)}\n`;
                ordersSummary += `*Date:* ${new Date(order.orderDate).toLocaleDateString()} ${new Date(order.orderDate).toLocaleTimeString()}\n`;
                ordersSummary += `*Items:* ${order.items.map(item => `${item.name} x${item.quantity}`).join(', ')}\n\n`;
            }
            ordersSummary += `For full details, please contact us or check your dashboard link (if applicable).`;
            message.reply(ordersSummary);

        } else if (lowerCaseMessage === '4' || lowerCaseMessage.includes('shop location')) {
            if (settings && settings.shopLocation && settings.shopLocation.latitude && settings.shopLocation.longitude) {
                const mapLink = `https://www.google.com/maps/search/?api=1&query=${settings.shopLocation.latitude},${settings.shopLocation.longitude}`;
                message.reply(`Here's our shop location:\n${mapLink}\n\nWe look forward to seeing you!`);
            } else {
                message.reply('Shop location is not configured yet. Please check back later!');
            }
        } else if (lowerCaseMessage === '5' || lowerCaseMessage.includes('contact us')) {
            message.reply(`You can reach us directly on this WhatsApp number or call us at ${message.from}.`);
        } else if (lowerCaseMessage.includes('cancel order')) {
             message.reply("If you wish to cancel an order, please provide the Order ID or describe the order clearly so we can assist you. For example: 'Cancel order ID 123456'.");
        }
        else {
            const orderRegex = /([a-zA-Z0-9\s]+)\s*x\s*(\d+)/g;
            let match;
            const requestedItems = [];
            while ((match = orderRegex.exec(message.body)) !== null) {
                requestedItems.push({ name: match[1].trim(), quantity: parseInt(match[2]) });
            }

            if (requestedItems.length > 0) {
                let orderItems = [];
                let subtotal = 0;
                let invalidItems = [];

                for (const reqItem of requestedItems) {
                    const menuItem = await MenuItem.findOne({
                        name: { $regex: new RegExp(`^${reqItem.name}$`, 'i') },
                        isAvailable: true
                    });

                    if (menuItem) {
                        orderItems.push({
                            menuItemId: menuItem._id,
                            name: menuItem.name,
                            quantity: reqItem.quantity,
                            price: menuItem.price
                        });
                        subtotal += menuItem.price * reqItem.quantity;
                    } else {
                        invalidItems.push(reqItem.name);
                    }
                }

                if (orderItems.length > 0) {
                    let responseMessage = `Got it! Here's your order summary:\n\n`;
                    orderItems.forEach(item => {
                        responseMessage += `*${item.name}* x${item.quantity} = ₹${(item.price * item.quantity).toFixed(2)}\n`;
                    });

                    let transportTax = 0;
                    let deliveryAddress = customer.deliveryAddress || 'Not provided yet';
                    let customerLocation = customer.lastKnownLocation;

                    if (!customerLocation && message.hasMedia && message.type === 'location') {
                        customerLocation = {
                            latitude: message.location.latitude,
                            longitude: message.location.longitude
                        };
                        customer.lastKnownLocation = customerLocation;
                        await customer.save();
                        responseMessage += `\n*Delivery Location:* Received from your message.`;
                    } else if (!customerLocation) {
                        responseMessage += `\n\n*Please share your current location for delivery fee calculation and address confirmation.* You can do this by sending your location via WhatsApp.`;
                    }

                    if (customerLocation && settings && settings.shopLocation && settings.deliveryRates && settings.deliveryRates.length > 0) {
                        const dist = haversineDistance(
                            settings.shopLocation.latitude, settings.shopLocation.longitude,
                            customerLocation.latitude, customerLocation.longitude
                        );
                        responseMessage += `\n*Distance:* ${dist.toFixed(2)} km`;

                        const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

                        for (let i = 0; i < sortedRates.length; i++) {
                            const rate = sortedRates[i];
                            if (dist <= rate.kms) {
                                transportTax = rate.amount;
                                break;
                            }
                            if (i === sortedRates.length - 1 && dist > sortedRates[i].kms) {
                                transportTax = sortedRates[i].amount;
                            }
                        }
                        responseMessage += `\n*Delivery Fee:* ₹${transportTax.toFixed(2)}`;
                    } else {
                        responseMessage += `\n*Delivery Fee:* Will be calculated upon location confirmation.`;
                    }

                    const totalAmount = subtotal + transportTax;
                    responseMessage += `\n*Subtotal:* ₹${subtotal.toFixed(2)}\n*Total:* ₹${totalAmount.toFixed(2)}\n\n`;

                    if (invalidItems.length > 0) {
                        responseMessage += `_Note: The following items were not found or are unavailable: ${invalidItems.join(', ')}_\n\n`;
                    }

                    responseMessage += `To confirm your order, please reply with *Confirm Order*.`;
                    message.reply(responseMessage);

                    await Order.create({
                        customerPhone: message.from,
                        customerName: customer.customerName,
                        items: orderItems,
                        subtotal,
                        transportTax,
                        totalAmount,
                        deliveryAddress: deliveryAddress,
                        customerLocation: customerLocation,
                        status: 'Pending Confirmation',
                        paymentMethod: 'COD'
                    });

                } else if (invalidItems.length > 0) {
                    message.reply(`Sorry, I couldn't find the following items in our menu: ${invalidItems.join(', ')}. Please check the menu and try again!`);
                } else {
                    message.reply('I could not understand your order request. Please send items and quantities, e.g., "Burger x2".');
                }
            } else if (lowerCaseMessage === 'confirm order') {
                const latestOrder = await Order.findOne({ customerPhone: message.from }).sort({ orderDate: -1 });

                if (latestOrder && latestOrder.status === 'Pending Confirmation') {
                    latestOrder.status = 'Pending';
                    if (customer.lastKnownLocation && !latestOrder.deliveryAddress) {
                        latestOrder.deliveryAddress = `Delivery near Lat: ${customer.lastKnownLocation.latitude.toFixed(4)}, Lon: ${customer.lastKnownLocation.longitude.toFixed(4)}`;
                    }
                    await latestOrder.save();
                    message.reply(`Thank you for confirming! Your order (ID: ${latestOrder._id.toString().substring(0, 8)}...) has been placed and is *Pending*. We will process it shortly.`);
                    io.emit('new_order', latestOrder);

                } else {
                    message.reply('No pending order to confirm. Please place an order first!');
                }
            }
            else {
                message.reply('Sorry, I did not understand that. Please use one of the options or try ordering food.');
            }
        }
    });

    whatsappClient.initialize().catch(err => {
        console.error('WhatsApp Client Initialization Error:', err);
        updateBotStatus('error');
    });
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

const authenticateAdmin = (req, res, next) => {
    const token = req.cookies && req.cookies.token;
    if (!token && req.headers.authorization) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.split(' ')[1];
        }
    }

    if (!token) {
        return res.status(401).json({ message: 'No token, authorization denied' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.admin = decoded.admin;
        next();
    } catch (err) {
        console.error('Token verification error:', err);
        res.status(401).json({ message: 'Token is not valid' });
    }
};

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const admin = await Admin.findOne({ username });
        if (!admin) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        const isMatch = await bcrypt.compare(password, admin.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Invalid Credentials' });
        }

        const payload = {
            admin: {
                id: admin.id
            }
        };

        jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' }, (err, token) => {
            if (err) throw err;
            res.json({ token, message: 'Login successful' });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/admin/logout', (req, res) => {
    res.redirect('/admin/login.html');
});

app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
});

app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

app.get('/api/admin/bot-status', authenticateAdmin, (req, res) => {
    res.json({ status: whatsappStatus, qrCode: qrCodeData });
});

app.post('/api/public/request-qr', (req, res) => {
    try {
        if (whatsappClient) {
            console.log('Requesting new QR...');
            whatsappClient.destroy().then(() => {
                initializeWhatsAppClient(false);
                res.status(200).json({ message: 'New QR generation initiated. Check dashboard in a moment.' });
            }).catch(e => {
                console.error("Error destroying client for new QR:", e);
                res.status(500).json({ message: 'Failed to reset bot for new QR.' });
            });
        } else {
            initializeWhatsAppClient(false);
            res.status(200).json({ message: 'WhatsApp bot initialization started. QR will appear shortly.' });
        }
    } catch (error) {
        console.error('Error requesting QR:', error);
        res.status(500).json({ message: 'Failed to request QR code.' });
    }
});

app.post('/api/admin/load-session', authenticateAdmin, (req, res) => {
    try {
        console.log('Attempting to load saved session...');
        initializeWhatsAppClient(true);
        res.status(200).json({ message: 'Attempting to load saved session. Check bot status.' });
    } catch (error) {
        console.error('Error loading session:', error);
        res.status(500).json({ message: 'Failed to load session.' });
    }
});

app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID' });
        }
        res.status(500).send('Server Error');
    }
});

app.put('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    const { status } = req.body;
    try {
        let order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        order.status = status;
        await order.save();

        if (whatsappClient && whatsappStatus === 'ready') {
            const customerPhone = order.customerPhone.includes('@c.us') ? order.customerPhone : `${order.customerPhone}@c.us`;
            const statusMessage = `📢 Your order (ID: ${order._id.toString().substring(0, 8)}...) from *${(await Settings.findOne({}))?.shopName || 'Delicious Bites'}* has been updated to: *${status}*!`;
            whatsappClient.sendMessage(customerPhone, statusMessage).catch(e => console.error("Failed to send status update:", e));
        }

        res.json(order);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    try {
        const order = await Order.findByIdAndDelete(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json({ message: 'Order deleted successfully' });
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID' });
        }
        res.status(500).send('Server Error');
    }
});

app.post('/api/admin/orders', authenticateAdmin, async (req, res) => {
    const { customerPhone, customerName, deliveryAddress, customerLocation, items, paymentMethod = 'COD' } = req.body;

    if (!customerPhone || !customerName || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: 'Missing required order fields (customerPhone, customerName, items).' });
    }

    try {
        let subtotal = 0;
        const processedItems = [];

        for (const item of items) {
            const menuItem = await MenuItem.findById(item.menuItemId);
            if (!menuItem || !menuItem.isAvailable) {
                return res.status(400).json({ message: `Menu item not found or unavailable: ${item.name || item.menuItemId}` });
            }
            processedItems.push({
                menuItemId: menuItem._id,
                name: menuItem.name,
                quantity: item.quantity,
                price: menuItem.price
            });
            subtotal += menuItem.price * item.quantity;
        }

        let transportTax = 0;
        const settings = await Settings.findOne({});
        if (customerLocation && settings && settings.shopLocation && settings.deliveryRates && settings.deliveryRates.length > 0) {
            const dist = haversineDistance(
                settings.shopLocation.latitude, settings.shopLocation.longitude,
                customerLocation.latitude, customerLocation.longitude
            );
            const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

            for (let i = 0; i < sortedRates.length; i++) {
                const rate = sortedRates[i];
                if (dist <= rate.kms) {
                    transportTax = rate.amount;
                    break;
                }
                if (i === sortedRates.length - 1 && dist > sortedRates[i].kms) {
                    transportTax = sortedRates[i].amount;
                }
            }
        }

        const totalAmount = subtotal + transportTax;

        const newOrder = new Order({
            customerPhone,
            customerName,
            items: processedItems,
            subtotal,
            transportTax,
            totalAmount,
            deliveryAddress: deliveryAddress || (customerLocation ? `Lat: ${customerLocation.latitude.toFixed(4)}, Lon: ${customerLocation.longitude.toFixed(4)}` : 'Address not specified'),
            customerLocation,
            status: 'Confirmed',
            paymentMethod,
            orderDate: new Date()
        });

        await newOrder.save();
        res.status(201).json(newOrder);
        io.emit('new_order', newOrder);
    } catch (err) {
        console.error('Error creating order:', err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/admin/menu', authenticateAdmin, async (req, res) => {
    try {
        const menuItems = await MenuItem.find();
        res.json(menuItems);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.post('/api/admin/menu', authenticateAdmin, async (req, res) => {
    const { name, description, price, imageUrl, category, isAvailable, isTrending } = req.body;
    try {
        const newItem = new MenuItem({ name, description, price, imageUrl, category, isAvailable, isTrending });
        await newItem.save();
        res.status(201).json(newItem);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.put('/api/admin/menu/:id', authenticateAdmin, async (req, res) => {
    const { name, description, price, imageUrl, category, isAvailable, isTrending } = req.body;
    try {
        let item = await MenuItem.findById(req.params.id);
        if (!item) {
            return res.status(404).json({ message: 'Menu item not found' });
        }
        item.name = name;
        item.description = description;
        item.price = price;
        item.imageUrl = imageUrl;
        item.category = category;
        item.isAvailable = isAvailable;
        item.isTrending = isTrending;
        await item.save();
        res.json(item);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/admin/menu/:id', authenticateAdmin, async (req, res) => {
    try {
        const item = await MenuItem.findByIdAndDelete(req.params.id);
        if (!item) {
            return res.status(404).json({ message: 'Menu item not found' });
        }
        res.json({ message: 'Menu item deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = await Settings.findOne({});
        res.json(settings || {});
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.put('/api/admin/settings', authenticateAdmin, async (req, res) => {
    const { shopName, shopLocation, deliveryRates } = req.body;
    try {
        let settings = await Settings.findOne({});
        if (!settings) {
            settings = new Settings({ shopName, shopLocation, deliveryRates });
        } else {
            settings.shopName = shopName;
            settings.shopLocation = shopLocation;
            settings.deliveryRates = deliveryRates;
        }
        await settings.save();
        res.json(settings);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.get('/api/admin/customers', authenticateAdmin, async (req, res) => {
    try {
        const customers = await Customer.find().sort({ lastSeen: -1 });
        res.json(customers);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.delete('/api/admin/customers/:phone', authenticateAdmin, async (req, res) => {
    try {
        const customerPhone = req.params.phone;
        const customer = await Customer.findOneAndDelete({ customerPhone });
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        res.json({ message: 'Customer deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.post('/api/admin/customers', authenticateAdmin, async (req, res) => {
    const { customerPhone, customerName, lastKnownLocation, deliveryAddress } = req.body;

    if (!customerPhone || !customerName) {
        return res.status(400).json({ message: 'Customer phone and name are required.' });
    }

    try {
        let customer = await Customer.findOne({ customerPhone });
        if (customer) {
            return res.status(409).json({ message: 'Customer with this phone number already exists.' });
        }

        customer = new Customer({
            customerPhone,
            customerName,
            lastKnownLocation,
            deliveryAddress
        });
        await customer.save();
        res.status(201).json(customer);
    } catch (err) {
        console.error('Error adding customer:', err.message);
        res.status(500).send('Server Error');
    }
});

app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, items, deliveryAddress, customerLocation, paymentMethod } = req.body;

    if (!customerName || !customerPhone || !items || !Array.isArray(items) || items.length === 0 || !deliveryAddress) {
        return res.status(400).json({ message: 'Missing required order details' });
    }

    try {
        let customer = await Customer.findOne({ customerPhone });
        if (!customer) {
            customer = new Customer({ customerPhone, customerName });
        }
        if (customer.customerName === 'Customer' || (customerName && customer.customerName !== customerName)) {
            customer.customerName = customerName;
        }
        if (customerLocation && customerLocation.latitude && customerLocation.longitude) {
            customer.lastKnownLocation = customerLocation;
        }
        if (deliveryAddress) {
            customer.deliveryAddress = deliveryAddress;
        }
        await customer.save();

        let subtotal = 0;
        const orderItems = [];
        for (const item of items) {
            const menuItem = await MenuItem.findById(item.menuItemId);
            if (!menuItem || !menuItem.isAvailable) {
                return res.status(400).json({ message: `Menu item not found or unavailable: ${item.name || item.menuItemId}` });
            }
            orderItems.push({
                menuItemId: menuItem._id,
                name: menuItem.name,
                quantity: item.quantity,
                price: menuItem.price
            });
            subtotal += menuItem.price * item.quantity;
        }

        let transportTax = 0;
        const settings = await Settings.findOne({});
        if (customerLocation && settings && settings.shopLocation && settings.deliveryRates && settings.deliveryRates.length > 0) {
            const dist = haversineDistance(
                settings.shopLocation.latitude, settings.shopLocation.longitude,
                customerLocation.latitude, customerLocation.longitude
            );
            const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

            for (let i = 0; i < sortedRates.length; i++) {
                const rate = sortedRates[i];
                if (dist <= rate.kms) {
                    transportTax = rate.amount;
                    break;
                }
                if (i === sortedRates.length - 1 && dist > sortedRates[i].kms) {
                    transportTax = sortedRates[i].amount;
                }
            }
        }

        const totalAmount = subtotal + transportTax;

        const newOrder = new Order({
            customerName,
            customerPhone,
            items: orderItems,
            subtotal,
            transportTax,
            totalAmount,
            deliveryAddress,
            customerLocation: customerLocation || null,
            status: 'Pending',
            paymentMethod: paymentMethod || 'COD'
        });

        await newOrder.save();

        io.emit('new_order', newOrder);

        if (whatsappClient && whatsappStatus === 'ready') {
            const confirmationMessage = `🎉 Your order (ID: ${newOrder._id.toString().substring(0, 8)}...) has been placed successfully from *${settings?.shopName || 'Delicious Bites'}*!\nTotal: ₹${newOrder.totalAmount.toFixed(2)}\nStatus: *Pending*\nWe will confirm and process it shortly.`;
            const formattedPhone = customerPhone.includes('@c.us') ? customerPhone : `${customerPhone.replace(/\D/g, '')}@c.us`;
            whatsappClient.sendMessage(formattedPhone, confirmationMessage).catch(e => console.error("Failed to send order confirmation:", e));
        }

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });
    } catch (err) {
        console.error('Error placing web order:', err.message);
        res.status(500).json({ message: 'Error placing order', error: err.message });
    }
});

app.get('/api/order/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') {
            return res.status(400).json({ message: 'Invalid Order ID' });
        }
        res.status(500).send('Server Error');
    }
});

app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne({});
        if (settings) {
            return res.json({
                shopName: settings.shopName,
                shopLocation: settings.shopLocation,
                deliveryRates: settings.deliveryRates
            });
        }
        res.json({});
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

app.post('/api/calculate-delivery-cost', async (req, res) => {
    const { customerLocation } = req.body;

    if (!customerLocation || typeof customerLocation.latitude === 'undefined' || typeof customerLocation.longitude === 'undefined') {
        return res.status(400).json({ message: 'Customer location (latitude and longitude) is required.' });
    }

    try {
        const settings = await Settings.findOne({});
        if (!settings || !settings.shopLocation || !settings.deliveryRates || settings.deliveryRates.length === 0) {
            return res.status(400).json({ message: 'Delivery settings are not configured on the server.' });
        }

        const dist = haversineDistance(
            settings.shopLocation.latitude, settings.shopLocation.longitude,
            customerLocation.latitude, customerLocation.longitude
        );

        let transportTax = 0;
        const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

        for (let i = 0; i < sortedRates.length; i++) {
            const rate = sortedRates[i];
            if (dist <= rate.kms) {
                transportTax = rate.amount;
                break;
            }
            if (i === sortedRates.length - 1 && dist > sortedRates[i].kms) {
                transportTax = sortedRates[i].amount;
            }
        }

        res.json({ distance: dist, transportTax: transportTax });

    } catch (err) {
        console.error('Error calculating delivery cost:', err.message);
        res.status(500).json({ message: 'Error calculating delivery cost', error: err.message });
    }
});

io.on('connection', (socket) => {
    console.log('Admin dashboard connected');
    socket.emit('status', whatsappStatus);
    if (qrCodeData) {
        socket.emit('qrCode', qrCodeData);
    }

    socket.on('disconnect', () => {
        console.log('Admin dashboard disconnected');
    });
});

initializeWhatsAppClient(true);

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Dashboard: http://localhost:${PORT}/admin/login`);
    console.log(`Public Menu: http://localhost:${PORT}/menu`);
    console.log(`Bot Status: http://localhost:${PORT}/bot_status`);
});


