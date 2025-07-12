const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const session = require('express-session'); // For session management

const app = express();
app.use(express.json());
// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure session middleware
app.use(session({
    secret: 'siddhikreddy', // Replace with a strong, random secret in production
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// --- Basic Authentication Middleware ---
// For demonstration purposes. In production, use environment variables for credentials
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'password'; // Use a hashed password in production
// IMPORTANT: Replace with the actual WhatsApp number of the admin (e.g., '919876543210')
const ADMIN_WHATSAPP_NUMBER = '918897350151'; 

const isAuthenticated = (req, res, next) => {
    if (req.session.isAuthenticated) {
        return next();
    }
    res.redirect('/login');
};

// MongoDB connection
const MONGO_URI = 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
let db;

// Connect to MongoDB
MongoClient.connect(MONGO_URI)
    .then(client => {
        console.log('✅ Connected to MongoDB');
        db = client.db('foodiebot');
        // Optional: Insert some sample menu items if the collection is empty
        insertSampleMenuItems(db);
    })
    .catch(error => console.error('❌ MongoDB connection error:', error));

// Function to insert sample menu items if the collection is empty
async function insertSampleMenuItems(db) {
    const menuCollection = db.collection('menu_items');
    const count = await menuCollection.countDocuments();
    if (count === 0) {
        const sampleItems = [
            { name: 'Margherita Pizza', price: 250, description: 'Classic cheese and tomato pizza', category: 'Pizza' },
            { name: 'Pepperoni Pizza', price: 300, description: 'Pepperoni, mozzarella, and tomato sauce', category: 'Pizza' },
            { name: 'Veggie Burger', price: 180, description: 'Patty made with fresh vegetables', category: 'Burgers' },
            { name: 'Chicken Burger', price: 220, description: 'Grilled chicken patty with fresh toppings', category: 'Burgers' },
            { name: 'French Fries', price: 100, description: 'Crispy golden fries', category: 'Sides' },
            { name: 'Coca-Cola', price: 60, description: 'Refreshing cold drink', category: 'Drinks' },
            { name: 'Chicken Biryani', price: 350, description: 'Aromatic rice dish with marinated chicken', category: 'Main Course' },
            { name: 'Paneer Butter Masala', price: 280, description: 'Creamy paneer curry', category: 'Main Course' },
            { name: 'Garlic Naan', price: 70, description: 'Soft bread with garlic butter', category: 'Breads' },
            { name: 'Gulab Jamun (2 pcs)', price: 120, description: 'Sweet milk-solid dumplings', category: 'Desserts' }
        ];
        await menuCollection.insertMany(sampleItems);
        console.log('✅ Sample menu items inserted into MongoDB.');
    } else {
        console.log('✅ Menu items already exist in MongoDB.');
    }
}


// Helper function to generate unique order ID
const generateOrderId = () => {
    const timestamp = Date.now().toString();
    const random = Math.random().toString(36).substr(2, 5).toUpperCase();
    return `ORD${timestamp.slice(-6)}${random}`;
};

// Bot state
let botState = {
    qrCode: null,
    isAuthenticated: false,
    connectedSessions: 0,
    qrString: null // Store raw QR string for API
};

// User cart state and session management
// NOTE: For a production application, userCarts and userSessions should be persisted
// in a database (e.g., MongoDB) rather than in-memory, as data will be lost on server restart.
const userCarts = new Map();
const userSessions = new Map(); // Track user conversation state

// WhatsApp Client with proper Puppeteer configuration
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            // '--single-process', // <- this one doesn't work in Windows, uncomment for Linux/Docker
            '--disable-gpu'
        ]
    }
});

// WhatsApp Event Handlers
client.on('qr', async (qr) => {
    console.log('📱 QR Code generated - Scan with WhatsApp to connect');
    console.log('QR Code available at: http://localhost:3000/qr');
    
    try {
        botState.qrCode = await qrcode.toDataURL(qr);
        botState.qrString = qr;
        botState.isAuthenticated = false;
        console.log('✅ QR Code generated successfully');
    } catch (error) {
        console.error('❌ Error generating QR code:', error);
    }
});

client.on('ready', () => {
    console.log('✅ WhatsApp bot is ready and connected!');
    botState.isAuthenticated = true;
    botState.connectedSessions = 1;
    botState.qrCode = null;
    botState.qrString = null;
});

client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated successfully');
    botState.isAuthenticated = true;
});

client.on('auth_failure', (msg) => {
    console.log('❌ WhatsApp authentication failed:', msg);
    botState.isAuthenticated = false;
    botState.qrCode = null;
    botState.qrString = null;
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
    botState.isAuthenticated = false;
    botState.connectedSessions = 0;
    // Reset QR code state to allow re-authentication
    botState.qrCode = null;
    botState.qrString = null;
});

// Helper function to get or create user profile
const getUserProfile = async (userPhone) => {
    let user = await db.collection('users').findOne({ phone: userPhone });
    if (!user) {
        user = {
            phone: userPhone,
            name: null,
            address: null,
            isProfileComplete: false,
            createdAt: new Date()
        };
        await db.collection('users').insertOne(user);
    }
    return user;
};

// Helper function to update user profile
const updateUserProfile = async (userPhone, updates) => {
    await db.collection('users').updateOne(
        { phone: userPhone },
        { $set: { ...updates, updatedAt: new Date() } }
    );
};

// Helper function to send welcome message with order URL
const sendWelcomeMessage = (message) => {
    const welcomeText = `🍽️ *Welcome to FoodieBot!* 🤖

Hello! I'm your personal food ordering assistant.

🌐 *ORDER NOW:*
Click here to browse our menu and place your order:
👆 https://your-restaurant-website.com/order

📦 Type *"cart"* - View your current order
✅ Type *"confirm"* - Place your order
👤 Type *"profile"* - View/Edit your profile
ℹ️ Type *"help"* - See this message again

Let's get started! Click the link above to see what delicious items we have available today! 🍕🍔🍜`;

    message.reply(welcomeText);
};

// Helper function to collect user details
const collectUserDetails = async (message, userPhone, userProfile) => {
    const session = userSessions.get(userPhone) || {};
    
    if (!userProfile.name) {
        userSessions.set(userPhone, { ...session, state: 'collecting_name' });
        message.reply('👋 Welcome! To complete your profile, please tell me your *full name*:');
        return true;
    }
    
    if (!userProfile.address) {
        userSessions.set(userPhone, { ...session, state: 'collecting_address' });
        message.reply('📍 Please provide your *delivery address*:\n\n(Include full address with landmark for accurate delivery)');
        return true;
    }
    
    return false; // Profile is complete
};

// Helper function to handle profile completion
const handleProfileCompletion = async (message, userPhone, messageBody) => {
    const session = userSessions.get(userPhone) || {};
    
    if (session.state === 'collecting_name') {
        await updateUserProfile(userPhone, { name: messageBody });
        userSessions.set(userPhone, { ...session, state: 'collecting_address' });
        message.reply('✅ Name saved!\n\n📍 Now please provide your *delivery address*:\n\n(Include full address with landmark for accurate delivery)');
        return true;
    }
    
    if (session.state === 'collecting_address') {
        await updateUserProfile(userPhone, { 
            address: messageBody,
            isProfileComplete: true 
        });
        userSessions.set(userPhone, { ...session, state: null });
        message.reply('✅ *Profile completed successfully!*\n\n🌐 *ORDER NOW:*\nClick here to browse our menu and place your order:\n👆 https://your-restaurant-website.com/order');
        return true;
    }
    
    return false;
};

// Payment verification helper
const handlePaymentVerification = async (message, userPhone, messageBody) => {
    const session = userSessions.get(userPhone) || {};
    
    if (session.state === 'awaiting_upi_proof') {
        // Check if message has attachment (screenshot)
        if (message.hasMedia) {
            const media = await message.downloadMedia();
            if (media.mimetype.startsWith('image/')) {
                // NOTE: Storing base64 media directly in MongoDB can lead to large document sizes.
                // For production, consider uploading images to cloud storage (e.g., AWS S3, Google Cloud Storage)
                // and storing the URL in MongoDB instead.
                const paymentProof = {
                    orderId: session.pendingOrderId,
                    customerPhone: userPhone,
                    paymentMethod: 'UPI',
                    proofType: 'screenshot',
                    mediaData: media.data, // Base64 string of the image
                    timestamp: new Date(),
                    status: 'pending_verification'
                };
                
                await db.collection('payment_proofs').insertOne(paymentProof);
                
                // Update order status
                await db.collection('orders').updateOne(
                    { _id: new ObjectId(session.pendingOrderId) },
                    { $set: { paymentStatus: 'verification_pending', paymentProofId: paymentProof._id } }
                );
                
                userSessions.set(userPhone, { ...session, state: null, pendingOrderId: null });
                
                message.reply('✅ *Payment screenshot received!*\n\n🔍 Your payment is under verification. We\'ll confirm your order once payment is verified.\n\nThank you for choosing FoodieBot! 🍽️');
                return true;
            }
        }
        
        // Check if it's UTR number (12 digits)
        if (/^\d{12}$/.test(messageBody)) {
            const paymentProof = {
                orderId: session.pendingOrderId,
                customerPhone: userPhone,
                paymentMethod: 'UPI',
                proofType: 'utr',
                utrNumber: messageBody,
                timestamp: new Date(),
                status: 'pending_verification'
            };
            
            await db.collection('payment_proofs').insertOne(paymentProof);
            
            await db.collection('orders').updateOne(
                { _id: new ObjectId(session.pendingOrderId) },
                { $set: { paymentStatus: 'verification_pending', paymentProofId: paymentProof._id } }
            );
            
            userSessions.set(userPhone, { ...session, state: null, pendingOrderId: null });
            
            message.reply(`✅ *UTR Number received!*\n\nUTR: ${messageBody}\n\n🔍 Your payment is under verification. We\'ll confirm your order once payment is verified.\n\nThank you for choosing FoodieBot! 🍽️`);
            return true;
        }
        
        message.reply('❌ Please send either:\n• Payment screenshot (image)\n• 12-digit UTR number\n\nOr type "cod" to switch to Cash on Delivery');
        return true;
    }
    
    return false;
};

// Payment options helper
const showPaymentOptions = (message, total, orderId) => {
    const paymentText = `💳 *Payment Options*\n\n💰 Total Amount: ₹${total}\n\n*Choose your payment method:*\n\n🏦 *UPI Payment*\nType "upi" to pay via UPI\n• PhonePe: 9876543210\n• Google Pay: 9876543210\n• Paytm: 9876543210\n\n💵 *Cash on Delivery*\nType "cod" for cash payment on delivery\n\nPlease select your preferred payment method:`;
    
    message.reply(paymentText);
};

// Message handler
client.on('message', async (message) => {
    const chat = await message.getChat();
    const contact = await message.getContact();
    const userPhone = contact.number;
    const messageBody = message.body.toLowerCase().trim();
    
    try {
        // Initialize user cart if doesn't exist
        if (!userCarts.has(userPhone)) {
            userCarts.set(userPhone, []);
        }
        
        // Get user profile
        const userProfile = await getUserProfile(userPhone);
        
        // Handle payment verification first
        if (await handlePaymentVerification(message, userPhone, message.body)) {
            return;
        }
        
        // Handle profile completion
        if (await handleProfileCompletion(message, userPhone, message.body)) {
            return;
        }
        
        // Check if profile is complete before allowing orders
        if (!userProfile.isProfileComplete && !['hello', 'hi', 'start', 'help', 'profile', 'order'].includes(messageBody)) {
            if (await collectUserDetails(message, userPhone, userProfile)) {
                return;
            }
        }
        
        // Handle different commands
        if (messageBody === 'hello' || messageBody === 'hi' || messageBody === 'start' || messageBody === 'help') {
            sendWelcomeMessage(message);
        }
        else if (messageBody === 'order') {
            const orderText = `🌐 *ORDER NOW:*\n\nClick here to browse our menu and place your order:\n👆 https://your-restaurant-website.com/order\n\n📱 After placing your order online, return here to:\n• Track your order status\n• Make payment\n• Get delivery updates\n\nHappy ordering! 🍽️`;
            message.reply(orderText);
        }
        else if (messageBody === 'profile') {
            let profileText = '👤 *Your Profile*\n\n';
            profileText += `📱 Phone: ${userPhone}\n`;
            profileText += `👋 Name: ${userProfile.name || 'Not set'}\n`;
            profileText += `📍 Address: ${userProfile.address || 'Not set'}\n\n`;
            
            if (!userProfile.isProfileComplete) {
                profileText += '⚠️ Profile incomplete. Please complete your profile to place orders.\n\n';
                if (!userProfile.name) {
                    profileText += 'Type your *full name* to update:';
                } else if (!userProfile.address) {
                    profileText += 'Type your *delivery address* to update:';
                }
            } else {
                profileText += '✅ Profile complete!\n\n';
                profileText += 'To update:\n• Type "update name" to change name\n• Type "update address" to change address';
            }
            
            message.reply(profileText);
        }
        else if (messageBody === 'update name') {
            userSessions.set(userPhone, { state: 'collecting_name' });
            message.reply('👋 Please enter your *new name*:');
        }
        else if (messageBody === 'update address') {
            userSessions.set(userPhone, { state: 'collecting_address' });
            message.reply('📍 Please enter your *new delivery address*:');
        }
        else if (messageBody === 'cart') {
            const userCart = userCarts.get(userPhone);
            if (userCart.length === 0) {
                message.reply('🛒 Your cart is empty.\n\n🌐 *ORDER NOW:*\nClick here to browse our menu and add items:\n👆 https://your-restaurant-website.com/order');
                return;
            }
            
            let cartText = '🛒 *Your Cart*\n\n';
            let total = 0;
            
            userCart.forEach((item, index) => {
                cartText += `${index + 1}. ${item.name} x${item.quantity} - ₹${item.price * item.quantity}\n`;
                total += item.price * item.quantity;
            });
            
            cartText += `\n💰 *Total: ₹${total}*\n\n`;
            cartText += '✅ Type "confirm" to place order\n';
            cartText += '🌐 Click here to add more items:\n👆 https://your-restaurant-website.com/order';
            
            message.reply(cartText);
        }
        else if (messageBody === 'confirm') {
            const userCart = userCarts.get(userPhone);
            if (userCart.length === 0) {
                message.reply('🛒 Your cart is empty.\n\n🌐 *ORDER NOW:*\nClick here to browse our menu and add items:\n👆 https://your-restaurant-website.com/order');
                return;
            }
            
            // Calculate total
            const total = userCart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            
            // Generate unique order ID
            const orderId = generateOrderId();
            
            // Create order with orderId
            const order = {
                orderId: orderId,
                customerPhone: userPhone,
                customerName: userProfile.name,
                customerAddress: userProfile.address,
                items: userCart,
                total: total,
                status: 'pending_payment',
                paymentStatus: 'pending',
                timestamp: new Date(),
                createdAt: new Date()
            };
            
            const result = await db.collection('orders').insertOne(order);
            const mongoId = result.insertedId;
            
            // Show payment options
            showPaymentOptions(message, total, mongoId);
            
            // Store order ID in session for payment processing
            const session = userSessions.get(userPhone) || {};
            userSessions.set(userPhone, { ...session, pendingOrderId: mongoId.toString() });
        }
        else if (messageBody === 'upi') {
            const session = userSessions.get(userPhone) || {};
            if (!session.pendingOrderId) {
                message.reply('❌ No pending order found. Please place an order first by typing "confirm".');
                return;
            }
            
            const order = await db.collection('orders').findOne({ _id: new ObjectId(session.pendingOrderId) });
            if (!order) {
                message.reply('❌ Order not found. Please try again.');
                return;
            }
            
            userSessions.set(userPhone, { ...session, state: 'awaiting_upi_proof' });
            
            const upiText = `🏦 *UPI Payment Details*\n\n💰 Amount: ₹${order.total}\n📋 Order ID: ${order.orderId}\n\n*Pay to any of these UPI IDs:*\n• PhonePe: 9876543210\n• Google Pay: 9876543210\n• Paytm: 9876543210\n\n📸 *After payment, send:*\n• Payment screenshot (image), OR\n• 12-digit UTR number\n\n💡 Type "cod" to switch to Cash on Delivery`;
            
            message.reply(upiText);
        }
        else if (messageBody === 'cod') {
            const session = userSessions.get(userPhone) || {};
            if (!session.pendingOrderId) {
                message.reply('❌ No pending order found. Please place an order first by typing "confirm".');
                return;
            }
            
            // Update order with COD payment
            await db.collection('orders').updateOne(
                { _id: new ObjectId(session.pendingOrderId) },
                { 
                    $set: { 
                        paymentMethod: 'COD',
                        paymentStatus: 'cod_selected',
                        status: 'confirmed',
                        confirmedAt: new Date()
                    }
                }
            );
            
            const order = await db.collection('orders').findOne({ _id: new ObjectId(session.pendingOrderId) });
            
            // Clear cart and session
            userCarts.set(userPhone, []);
            userSessions.set(userPhone, { ...session, state: null, pendingOrderId: null });
            
            // Confirmation message
            let confirmText = '✅ *Order Confirmed with Cash on Delivery!*\n\n';
            confirmText += `📋 *Order ID: ${order.orderId}*\n\n`;
            confirmText += '*Order Summary:*\n';
            order.items.forEach((item, index) => {
                confirmText += `${index + 1}. ${item.name} x${item.quantity} - ₹${item.price * item.quantity}\n`;
            });
            confirmText += `\n💰 *Total: ₹${order.total}*\n`;
            confirmText += `💵 *Payment: Cash on Delivery*\n`;
            confirmText += `📍 *Delivery Address:*\n${userProfile.address}\n\n`;
            confirmText += '🚚 Your order is being prepared. We\'ll update you soon!\n';
            confirmText += 'Thank you for choosing FoodieBot! 🍽️';
            
            message.reply(confirmText);
        }
        else {
            // Unknown command - show available options
            const helpText = `🤔 I didn't understand that command.\n\n*Available commands:*\n• "order" - Get ordering link\n• "cart" - View your cart\n• "confirm" - Place order\n• "profile" - View/Edit profile\n• "help" - Show this help\n\n🌐 *ORDER NOW:*\nClick here to browse our menu:\n👆 https://your-restaurant-website.com/order`;
            message.reply(helpText);
        }
        
        // Store session data
        await db.collection('sessions').updateOne(
            { phone: contact.number },
            { 
                $set: { 
                    phone: contact.number,
                    name: contact.name || contact.pushname || userProfile.name,
                    lastMessage: message.body,
                    lastSeen: new Date()
                }
            },
            { upsert: true }
        );
        
    } catch (error) {
        console.error('Error handling message:', error);
        message.reply('😔 Sorry, something went wrong. Please try again or contact support.');
    }
});

// API endpoint to add items to cart from web interface
app.post('/api/add-to-cart', async (req, res) => {
    try {
        const { userPhone, items } = req.body;
        
        if (!userPhone || !items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Invalid request data' });
        }
        
        // Get user profile (or create if new)
        const userProfile = await getUserProfile(userPhone);

        // Calculate total
        const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        
        // Generate unique order ID
        const orderId = generateOrderId();
        
        // Create order with initial status pending admin approval
        const order = {
            orderId: orderId,
            customerPhone: userPhone,
            customerName: userProfile.name,
            customerAddress: userProfile.address,
            items: items,
            total: total,
            status: 'pending_admin_approval', // New initial status
            paymentStatus: 'awaiting_admin_review', // New initial payment status
            timestamp: new Date(),
            createdAt: new Date()
        };
        
        const result = await db.collection('orders').insertOne(order);
        const mongoId = result.insertedId;

        // Notify admin about the new order
        if (ADMIN_WHATSAPP_NUMBER && client.isReady) {
            const adminNotificationMessage = `🔔 *New Order Placed!* 🔔\n\n` +
                                             `📋 *Order ID:* ${order.orderId}\n` +
                                             `👤 *Customer:* ${order.customerName || order.customerPhone}\n` +
                                             `💰 *Total:* ₹${order.total}\n` +
                                             `Items: ${order.items.map(item => `${item.name} x${item.quantity}`).join(', ')}\n\n` +
                                             `Status: *Pending Admin Approval*\n\n` +
                                             `Go to dashboard to review: http://localhost:3000/dashboard`;
            await client.sendMessage(`${ADMIN_WHATSAPP_NUMBER}@c.us`, adminNotificationMessage);
            console.log(`✅ Admin notified about new order: ${order.orderId}`);
        } else {
            console.warn('Admin WhatsApp number not set or client not ready. Admin not notified.');
        }
        
        // Respond to the web panel without sending direct WhatsApp confirmation to user
        res.json({ success: true, message: 'Order placed successfully, awaiting admin confirmation.' });
    } catch (error) {
        console.error('Error adding to cart (web panel):', error);
        res.status(500).json({ error: error.message });
    }
});

// NEW: API endpoint to get menu items from MongoDB
app.get('/api/menu', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ error: 'Database not connected' });
        }
        const menuItems = await db.collection('menu_items').find({}).toArray();
        res.json(menuItems);
    } catch (error) {
        console.error('Error fetching menu items:', error);
        res.status(500).json({ error: 'Failed to fetch menu items' });
    }
});


// QR Code HTML page endpoint
app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// --- Authentication Routes ---
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAuthenticated = true;
        res.json({ success: true, redirect: '/dashboard' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Could not log out.');
        }
        res.redirect('/login');
    });
});

// API Routes (protected by isAuthenticated middleware)
app.get('/api/status', (req, res) => {
    res.json({
        isAuthenticated: botState.isAuthenticated,
        connectedSessions: botState.connectedSessions,
        qrGenerated: !!botState.qrCode
    });
});

app.get('/api/qr', (req, res) => {
    if (botState.qrCode) {
        const base64Data = botState.qrCode.replace(/^data:image\/png;base64,/, '');
        const img = Buffer.from(base64Data, 'base64');
        res.writeHead(200, { 
            'Content-Type': 'image/png',
            'Content-Length': img.length 
        });
        res.end(img);
    } else {
        res.status(404).json({ 
            error: 'QR code not available',
            message: botState.isAuthenticated ? 'Already authenticated' : 'QR code not generated yet'
        });
    }
});

// Force QR generation endpoint
app.post('/api/generate-qr', isAuthenticated, async (req, res) => {
    try {
        if (botState.isAuthenticated) {
            res.json({ error: 'Already authenticated' });
            return;
        }
        
        // Destroy existing client and create new one
        // This can sometimes be slow or lead to issues. Consider more robust re-auth logic
        // if this causes frequent problems in production.
        await client.destroy();
        
        setTimeout(() => {
            client.initialize();
        }, 2000); // Give some time before re-initializing
        
        res.json({ message: 'QR generation initiated' });
    } catch (error) {
        console.error('Error generating QR:', error);
        res.status(500).json({ error: error.message });
    }
});

// Orders API
app.get('/api/orders', isAuthenticated, async (req, res) => {
    try {
        const orders = await db.collection('orders')
            .find({})
            .sort({ createdAt: -1 })
            .limit(50) // Limit to recent 50 orders for dashboard display
            .toArray();
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get specific order
app.get('/api/orders/:orderId', isAuthenticated, async (req, res) => {
    try {
        const order = await db.collection('orders').findOne({ 
            orderId: req.params.orderId 
        });
        
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json(order);
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update order status
app.put('/api/orders/:orderId/status', isAuthenticated, async (req, res) => {
    try {
        const { status, paymentStatus } = req.body;
        const orderId = req.params.orderId;
        
        const updateData = {
            updatedAt: new Date()
        };
        
        if (status) updateData.status = status;
        if (paymentStatus) updateData.paymentStatus = paymentStatus;
        
        const result = await db.collection('orders').updateOne(
            { orderId: orderId },
            { $set: updateData }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        // Get updated order to send correct details to customer
        const updatedOrder = await db.collection('orders').findOne({ orderId: orderId });
        
        // Send status update to customer
        const statusMessages = {
            'confirmed': '✅ Your order has been confirmed and is being prepared!',
            'preparing': '👨‍🍳 Your order is being prepared with love!',
            'ready': '🍽️ Your order is ready for pickup/delivery!',
            'out_for_delivery': '🚚 Your order is out for delivery!',
            'delivered': '✅ Your order has been delivered! Enjoy your meal! 🍽️',
            'cancelled': '❌ Your order has been cancelled. Contact us for more info.'
        };
        
        // Only send message if the status is one that requires a customer notification
        if (statusMessages[status] && updatedOrder && updatedOrder.customerPhone) {
            const message = `📋 *Order Update - ${updatedOrder.orderId}*\n\n${statusMessages[status]}\n\nThank you for choosing FoodieBot! 🤖`;
            await client.sendMessage(`${updatedOrder.customerPhone}@c.us`, message);
            // If the order is confirmed, clear the user's in-memory cart (if they used the bot directly)
            if (status === 'confirmed') {
                userCarts.set(updatedOrder.customerPhone, []);
            }
        }
        
        res.json({ success: true, order: updatedOrder });
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ error: error.message });
    }
});

// Verify payment
app.put('/api/payments/:paymentId/verify', isAuthenticated, async (req, res) => {
    try {
        const { verified, notes } = req.body;
        const paymentId = req.params.paymentId;
        
        // Update payment proof
        await db.collection('payment_proofs').updateOne(
            { _id: new ObjectId(paymentId) },
            { 
                $set: { 
                    status: verified ? 'verified' : 'rejected',
                    verifiedAt: new Date(),
                    verificationNotes: notes
                }
            }
        );
        
        // Get payment proof to find associated order
        const paymentProof = await db.collection('payment_proofs').findOne({ 
            _id: new ObjectId(paymentId) 
        });
        
        if (paymentProof) {
            // Update order status
            const orderUpdateData = {
                paymentStatus: verified ? 'verified' : 'rejected',
                status: verified ? 'confirmed' : 'payment_failed',
                updatedAt: new Date()
            };
            
            if (verified) {
                orderUpdateData.confirmedAt = new Date();
            }
            
            await db.collection('orders').updateOne(
                { _id: new ObjectId(paymentProof.orderId) },
                { $set: orderUpdateData }
            );
            
            // Get order details
            const order = await db.collection('orders').findOne({ 
                _id: new ObjectId(paymentProof.orderId) 
            });
            
            // Send notification to customer
            if (order && order.customerPhone) {
                if (verified) {
                    const message = `✅ *Payment Verified!*\n\n📋 Order ID: ${order.orderId}\n💰 Amount: ₹${order.total}\n\nYour order is confirmed and being prepared! 👨‍🍳\n\nThank you for choosing FoodieBot! 🍽️`;
                    await client.sendMessage(`${order.customerPhone}@c.us`, message);
                    
                    // Clear user cart
                    userCarts.set(order.customerPhone, []);
                } else {
                    const message = `❌ *Payment Verification Failed*\n\n📋 Order ID: ${order.orderId}\n\n${notes || 'Please contact support or try a different payment method.'}\n\nType "upi" to retry payment or "cod" for cash on delivery.`;
                    await client.sendMessage(`${order.customerPhone}@c.us`, message);
                }
            }
        }
        
        res.json({ success: true, verified });
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get payment proofs
app.get('/api/payments', isAuthenticated, async (req, res) => {
    try {
        const payments = await db.collection('payment_proofs')
            .find({})
            .sort({ timestamp: -1 })
            .limit(50) // Limit to recent 50 payments for dashboard display
            .toArray();
        
        res.json(payments);
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({ error: error.message });
    }
});

// Users API
app.get('/api/users', isAuthenticated, async (req, res) => {
    try {
        const users = await db.collection('users')
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sessions API
app.get('/api/sessions', isAuthenticated, async (req, res) => {
    try {
        const sessions = await db.collection('sessions')
            .find({})
            .sort({ lastSeen: -1 })
            .toArray();
        
        res.json(sessions);
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Send message to user
app.post('/api/send-message', isAuthenticated, async (req, res) => {
    try {
        const { phone, message } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }
        
        // Ensure phone number is in correct format (e.g., '919876543210@c.us')
        await client.sendMessage(`${phone}@c.us`, message);
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Broadcast message to all users
app.post('/api/broadcast', isAuthenticated, async (req, res) => {
    try {
        const { message } = req.body;
        
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }
        
        // Get all users
        const users = await db.collection('users').find({}).toArray();
        
        let successCount = 0;
        let errorCount = 0;
        
        // Send message to each user
        for (const user of users) {
            try {
                if (user.phone) { // Ensure phone number exists
                    await client.sendMessage(`${user.phone}@c.us`, message);
                    successCount++;
                    
                    // Add small delay to avoid rate limiting by WhatsApp
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            } catch (error) {
                console.error(`Error sending to ${user.phone}:`, error);
                errorCount++;
            }
        }
        
        res.json({ 
            success: true, 
            message: `Broadcast completed. Success: ${successCount}, Errors: ${errorCount}`,
            successCount,
            errorCount
        });
    } catch (error) {
        console.error('Error broadcasting message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Clear user cart
app.delete('/api/cart/:phone', isAuthenticated, async (req, res) => {
    try {
        const phone = req.params.phone;
        userCarts.set(phone, []);
        res.json({ success: true, message: 'Cart cleared' });
    } catch (error) {
        console.error('Error clearing cart:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get user cart
app.get('/api/cart/:phone', isAuthenticated, async (req, res) => {
    try {
        const phone = req.params.phone;
        const cart = userCarts.get(phone) || [];
        res.json(cart);
    } catch (error) {
        console.error('Error fetching cart:', error);
        res.status(500).json({ error: error.message });
    }
});

// Dashboard endpoint (protected)
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Initialize WhatsApp client
console.log('🚀 Starting FoodieBot...');
client.initialize();

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🎯 Server running on port ${PORT}`);
    console.log(`📱 QR Code: http://localhost:${PORT}/qr`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/login (Login with admin/password)`);
    console.log(`🛒 Order Panel: http://localhost:${PORT}/order`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('🛑 Shutting down gracefully...');
    await client.destroy();
    process.exit(0);
});

