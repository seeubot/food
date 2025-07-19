require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const qrcode = require('qrcode'); // Explicitly require qrcode for QR generation
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
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey'; // Use a strong, unique key in production

// --- IMPORTANT: Check MONGODB_URI loading ---
const MONGODB_URI = process.env.MONGODB_URI;
console.log('Attempting to connect to MongoDB with URI:', MONGODB_URI ? 'URI Loaded (not displayed for security)' : 'URI UNDEFINED - Check your .env file!');

if (!MONGODB_URI) {
    console.error('FATAL ERROR: MONGODB_URI is not defined in your .env file or environment variables.');
    console.error('Please create a .env file in the root directory with MONGODB_URI="your_connection_string".');
    process.exit(1); // Exit the process if URI is not found
}
// --- End MONGODB_URI check ---


// Middleware
app.use(express.json()); // For parsing application/json
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' directory

// MongoDB Connection
mongoose.connect(MONGODB_URI) // Use the loaded MONGODB_URI
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));

// WhatsApp Client Initialization
let whatsappClient;
let qrCodeData = null; // Store QR code data (base64 image URL)
let whatsappStatus = 'initializing'; // Global status for the bot

function updateBotStatus(status, data = null) {
    whatsappStatus = status;
    io.emit('status', status); // Emit status to all connected admin dashboards
    if (status === 'qr_received' && data) {
        qrCodeData = data; // Store base64 image data
        io.emit('qrCode', data); // Emit QR code data to admin dashboard
    } else if (status === 'ready' || status === 'disconnected' || status === 'auth_failure') {
        qrCodeData = null; // Clear QR data when connected or disconnected
        io.emit('qrCode', null); // Clear QR on dashboard
    }
    console.log(`WhatsApp Bot Status: ${status}`);
}

async function initializeWhatsAppClient(loadSession = true) {
    if (whatsappClient) {
        // If client already exists, destroy it before reinitializing
        await whatsappClient.destroy().catch(e => console.error("Error destroying old client:", e));
        whatsappClient = null;
    }

    updateBotStatus('initializing');
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot', // Unique ID for this session
            dataPath: './.wwebjs_auth' // Directory to store session data
        }),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    whatsappClient.on('qr', async (qr) => {
        // Convert QR string to base64 image data URL
        qrcode.toDataURL(qr, { small: false }, (err, url) => {
            if (err) {
                console.error('Error generating QR code data URL:', err);
                updateBotStatus('qr_error');
            } else {
                updateBotStatus('qr_received', url); // Pass base64 image URL
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
        // Attempt to reinitialize after a delay, or wait for admin action
        setTimeout(() => {
            if (whatsappStatus !== 'ready' && whatsappStatus !== 'initializing') {
                 // Only reinitialize if not already in ready/initializing state
                console.log('Attempting to reinitialize after disconnection...');
                initializeWhatsAppClient(true); // Attempt to load session again
            }
        }, 5000);
    });

    whatsappClient.on('change_state', state => {
        console.log('Connection State Change:', state);
        if (state === 'CONNECTED') {
            updateBotStatus('ready');
        } else if (state === 'DISCONNECTED') {
             // This might overlap with 'disconnected' event, ensuring status is set.
            updateBotStatus('disconnected');
        } else {
            updateBotStatus(state); // For other states like 'OPENING', 'PAIRING', 'TIMEOUT'
        }
    });

    whatsappClient.on('message', async message => {
        console.log('Message received:', message.body);

        // Fetch customer or create if not exists
        let customer = await Customer.findOne({ customerPhone: message.from });
        if (!customer) {
            customer = new Customer({
                customerPhone: message.from,
                customerName: message._data.notifyName || 'Customer' // Get name from WhatsApp
            });
            await customer.save();
        } else {
            // Update customer name if it's generic and WhatsApp provides a better one
            if (customer.customerName === 'Customer' && message._data.notifyName) {
                customer.customerName = message._data.notifyName;
                await customer.save();
            }
        }


        // Fetch current shop settings for dynamic responses
        const settings = await Settings.findOne({});
        const shopName = settings ? settings.shopName : 'Our Shop';

        // --- Bot Logic ---
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
            // FIX: This section is updated to fetch and format orders more robustly.
            const customerPhone = message.from;
            const orders = await Order.find({ customerPhone }).sort({ orderDate: -1 }).limit(5); // Fetch last 5 orders

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
            // Provide contact information based on settings or default
            message.reply(`You can reach us directly on this WhatsApp number or call us at ${message.from}.`);
        } else if (lowerCaseMessage.includes('cancel order')) {
             message.reply("If you wish to cancel an order, please provide the Order ID or describe the order clearly so we can assist you. For example: 'Cancel order ID 123456'.");
        }
        else {
            // Attempt to parse order from message
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
                        name: { $regex: new RegExp(`^${reqItem.name}$`, 'i') }, // Case-insensitive match
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

                    // Calculate transport tax based on distance (if customer location is known and settings exist)
                    let transportTax = 0;
                    let deliveryAddress = customer.deliveryAddress || 'Not provided yet'; // Use stored address or prompt
                    let customerLocation = customer.lastKnownLocation; // Use stored location if available

                    if (!customerLocation && message.hasMedia && message.type === 'location') {
                        // If user sent location with the order
                        customerLocation = {
                            latitude: message.location.latitude,
                            longitude: message.location.longitude
                        };
                        customer.lastKnownLocation = customerLocation; // Update customer's last known location
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

                        // Sort delivery rates by kms in ascending order
                        const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

                        for (let i = 0; i < sortedRates.length; i++) {
                            const rate = sortedRates[i];
                            if (dist <= rate.kms) {
                                transportTax = rate.amount;
                                break;
                            }
                            // If it's the last rate and distance is greater, use this rate
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

                    // Store pending order details in a temporary session or directly to DB with 'Pending Confirmation' status
                    // For simplicity, we'll assume the next "Confirm Order" message confirms the last parsed order intention
                    // In a real app, you'd use a state machine or temporary storage
                    await Order.create({
                        customerPhone: message.from,
                        customerName: customer.customerName,
                        items: orderItems,
                        subtotal,
                        transportTax,
                        totalAmount,
                        deliveryAddress: deliveryAddress, // Will be updated on confirmation if location is new
                        customerLocation: customerLocation,
                        status: 'Pending Confirmation', // Temporary status
                        paymentMethod: 'COD' // Default
                    });

                } else if (invalidItems.length > 0) {
                    message.reply(`Sorry, I couldn't find the following items in our menu: ${invalidItems.join(', ')}. Please check the menu and try again!`);
                } else {
                    message.reply('I could not understand your order request. Please send items and quantities, e.g., "Burger x2".');
                }
            } else if (lowerCaseMessage === 'confirm order') {
                const latestOrder = await Order.findOne({ customerPhone: message.from }).sort({ orderDate: -1 });

                if (latestOrder && latestOrder.status === 'Pending Confirmation') {
                    latestOrder.status = 'Pending'; // Change to actual 'Pending' status
                    // If customer's location was sent just before, it's already updated on the customer object.
                    // If no explicit address was given, we might prompt for one or use general location.
                    // For now, assume location is for delivery address if provided.
                    if (customer.lastKnownLocation && !latestOrder.deliveryAddress) {
                        // A more sophisticated system would reverse geocode the coordinates
                        latestOrder.deliveryAddress = `Delivery near Lat: ${customer.lastKnownLocation.latitude.toFixed(4)}, Lon: ${customer.lastKnownLocation.longitude.toFixed(4)}`;
                    }
                    await latestOrder.save();
                    message.reply(`Thank you for confirming! Your order (ID: ${latestOrder._id.toString().substring(0, 8)}...) has been placed and is *Pending*. We will process it shortly.`);
                    io.emit('new_order', latestOrder); // Notify admin dashboard

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

// Haversine distance function (for calculating distance between two coordinates)
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of Earth in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}


// --- Admin Authentication Middleware ---
const authenticateAdmin = (req, res, next) => {
    const token = req.cookies && req.cookies.token; // Check for token in cookies (assuming cookie-parser might be used, but not explicitly added here)
    if (!token && req.headers.authorization) { // Fallback to Authorization header if no cookie
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
        req.admin = decoded.admin; // Attach admin payload to request
        next();
    } catch (err) {
        console.error('Token verification error:', err);
        res.status(401).json({ message: 'Token is not valid' });
    }
};

// --- Admin Routes ---

// Admin Login
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
            // For simplicity, we'll send token in JSON response.
            // In a real app, you'd set it as an HttpOnly cookie.
            res.json({ token, message: 'Login successful' });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Admin Logout (Client-side clears token usually)
app.get('/admin/logout', (req, res) => {
    // For JWT in HTTP-only cookies: res.clearCookie('token');
    res.redirect('/admin/login.html'); // Redirect to login page
});

// Route to serve the admin dashboard HTML
app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_dashboard.html'));
});

// Route to serve the admin login HTML
app.get('/admin/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin_login.html'));
});

// Initial bot status check for dashboard load
app.get('/api/admin/bot-status', authenticateAdmin, (req, res) => {
    res.json({ status: whatsappStatus, qrCode: qrCodeData });
});

// Request New QR Code
app.post('/api/public/request-qr', (req, res) => { // Public route as it's for initial setup
    try {
        if (whatsappClient) {
            console.log('Requesting new QR...');
            whatsappClient.destroy().then(() => {
                 // Reinitialize to get a new QR
                initializeWhatsAppClient(false); // Don't try to load existing session
                res.status(200).json({ message: 'New QR generation initiated. Check dashboard in a moment.' });
            }).catch(e => {
                console.error("Error destroying client for new QR:", e);
                res.status(500).json({ message: 'Failed to reset bot for new QR.' });
            });
        } else {
            initializeWhatsAppClient(false); // Start if not already running, don't load session
            res.status(200).json({ message: 'WhatsApp bot initialization started. QR will appear shortly.' });
        }
    } catch (error) {
        console.error('Error requesting QR:', error);
        res.status(500).json({ message: 'Failed to request QR code.' });
    }
});

// Load Saved Session (for disconnected bot)
app.post('/api/admin/load-session', authenticateAdmin, (req, res) => {
    try {
        console.log('Attempting to load saved session...');
        initializeWhatsAppClient(true); // Attempt to load saved session
        res.status(200).json({ message: 'Attempting to load saved session. Check bot status.' });
    } catch (error) {
        console.error('Error loading session:', error);
        res.status(500).json({ message: 'Failed to load session.' });
    }
});

// --- API Routes for Frontend (Admin Dashboard) ---

// Get all orders
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
    try {
        const orders = await Order.find().sort({ orderDate: -1 });
        res.json(orders);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Get single order by ID
app.get('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }
        res.json(order);
    } catch (err) {
        console.error(err.message);
        if (err.kind === 'ObjectId') { // Handle invalid ID format
            return res.status(400).json({ message: 'Invalid Order ID' });
        }
        res.status(500).send('Server Error');
    }
});

// Update order status
app.put('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
    const { status } = req.body;
    try {
        let order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        order.status = status;
        await order.save();

        // Optional: Send WhatsApp notification to customer about status update
        if (whatsappClient && whatsappStatus === 'ready') {
            const customerPhone = order.customerPhone.includes('@c.us') ? order.customerPhone : `${order.customerPhone}@c.us`; // Ensure correct format
            const statusMessage = `📢 Your order (ID: ${order._id.toString().substring(0, 8)}...) from *${(await Settings.findOne({}))?.shopName || 'Delicious Bites'}* has been updated to: *${status}*!`;
            whatsappClient.sendMessage(customerPhone, statusMessage).catch(e => console.error("Failed to send status update:", e));
        }

        res.json(order);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// NEW: Delete an order
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

// NEW: Manually create an order (Admin) - Basic implementation
app.post('/api/admin/orders', authenticateAdmin, async (req, res) => {
    const { customerPhone, customerName, deliveryAddress, customerLocation, items, paymentMethod = 'COD' } = req.body;

    // Validate essential fields
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
            // Sort delivery rates by kms in ascending order
            const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

            for (let i = 0; i < sortedRates.length; i++) {
                const rate = sortedRates[i];
                if (dist <= rate.kms) {
                    transportTax = rate.amount;
                    break;
                }
                // If it's the last rate and distance is greater, use this rate
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
            customerLocation, // Store provided customer location
            status: 'Confirmed', // Manually added orders are typically confirmed
            paymentMethod,
            orderDate: new Date()
        });

        await newOrder.save();
        res.status(201).json(newOrder);
        io.emit('new_order', newOrder); // Notify admin dashboard of new order
    } catch (err) {
        console.error('Error creating order:', err.message);
        res.status(500).send('Server Error');
    }
});


// Get all menu items
app.get('/api/admin/menu', authenticateAdmin, async (req, res) => {
    try {
        const menuItems = await MenuItem.find();
        res.json(menuItems);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Add/Update menu item
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

// Delete menu item
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

// Get shop settings
app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    try {
        const settings = await Settings.findOne({});
        res.json(settings || {}); // Return empty object if no settings found
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Update shop settings
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

// Get all customers with their last known locations
app.get('/api/admin/customers', authenticateAdmin, async (req, res) => {
    try {
        const customers = await Customer.find().sort({ lastSeen: -1 });
        res.json(customers);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// NEW: Delete a customer
app.delete('/api/admin/customers/:phone', authenticateAdmin, async (req, res) => {
    try {
        const customerPhone = req.params.phone;
        const customer = await Customer.findOneAndDelete({ customerPhone });
        if (!customer) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        // Optional: Also delete associated orders or set them to anonymous if customer is deleted.
        // For now, we'll just delete the customer profile.
        res.json({ message: 'Customer deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// NEW: Manually add a customer (Admin) - Basic implementation
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


// --- Public API for Web Orders (assuming a separate web frontend for ordering) ---
app.post('/api/orders', async (req, res) => {
    const { customerName, customerPhone, items, deliveryAddress, customerLocation, paymentMethod } = req.body;

    // Basic validation
    if (!customerName || !customerPhone || !items || !Array.isArray(items) || items.length === 0 || !deliveryAddress) {
        return res.status(400).json({ message: 'Missing required order details' });
    }

    try {
        // Find or create customer
        let customer = await Customer.findOne({ customerPhone });
        if (!customer) {
            customer = new Customer({ customerPhone, customerName });
        }
        // Update customer's name if a new one is provided or it was generic
        if (customer.customerName === 'Customer' || (customerName && customer.customerName !== customerName)) {
            customer.customerName = customerName;
        }
        // Update customer's last known location and delivery address
        if (customerLocation && customerLocation.latitude && customerLocation.longitude) {
            customer.lastKnownLocation = customerLocation;
        }
        if (deliveryAddress) {
            customer.deliveryAddress = deliveryAddress;
        }
        await customer.save(); // Save updated customer info

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
            // Sort delivery rates by kms in ascending order
            const sortedRates = [...settings.deliveryRates].sort((a, b) => a.kms - b.kms);

            for (let i = 0; i < sortedRates.length; i++) {
                const rate = sortedRates[i];
                if (dist <= rate.kms) {
                    transportTax = rate.amount;
                    break;
                }
                // If it's the last rate and distance is greater, use this rate
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
            customerLocation: customerLocation || null, // FIX: Ensure location is stored
            status: 'Pending', // Initial status for web orders
            paymentMethod: paymentMethod || 'COD' // Default to COD if not specified
        });

        await newOrder.save();

        // Notify admin dashboard via Socket.IO
        io.emit('new_order', newOrder);

        // Optional: Send WhatsApp confirmation to customer
        if (whatsappClient && whatsappStatus === 'ready') {
            const confirmationMessage = `🎉 Your order (ID: ${newOrder._id.toString().substring(0, 8)}...) has been placed successfully from *${settings?.shopName || 'Delicious Bites'}*!\nTotal: ₹${newOrder.totalAmount.toFixed(2)}\nStatus: *Pending*\nWe will confirm and process it shortly.`;
            const formattedPhone = customerPhone.includes('@c.us') ? customerPhone : `${customerPhone.replace(/\D/g, '')}@c.us`; // Ensure correct format
            whatsappClient.sendMessage(formattedPhone, confirmationMessage).catch(e => console.error("Failed to send order confirmation:", e));
        }

        res.status(201).json({ message: 'Order placed successfully!', order: newOrder });
    } catch (err) {
        console.error('Error placing web order:', err.message);
        res.status(500).json({ message: 'Error placing order', error: err.message });
    }
});

// Public API to get a single order for tracking
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


// Public API to get public shop settings
app.get('/api/public/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne({});
        // Only return necessary public settings
        if (settings) {
            return res.json({
                shopName: settings.shopName,
                shopLocation: settings.shopLocation,
                deliveryRates: settings.deliveryRates
            });
        }
        res.json({}); // Return empty if no settings
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

// Public API to calculate delivery cost
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


// --- WebSocket (Socket.IO) Connection ---
io.on('connection', (socket) => {
    console.log('Admin dashboard connected');
    // Send current bot status and QR code data to newly connected client
    socket.emit('status', whatsappStatus);
    if (qrCodeData) {
        socket.emit('qrCode', qrCodeData);
    }

    socket.on('disconnect', () => {
        console.log('Admin dashboard disconnected');
    });
});

// Start WhatsApp client initially
initializeWhatsAppClient(true); // Attempt to load saved session on startup

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin Dashboard: http://localhost:${PORT}/admin/login`);
    console.log(`Public Menu: http://localhost:${PORT}/menu`);
    console.log(`Bot Status: http://localhost:${PORT}/bot_status`);
});


