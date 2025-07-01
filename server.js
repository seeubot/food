const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoClient, ObjectId } = require('mongodb');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// MongoDB connection
const MONGO_URI = 'mongodb+srv://room:room@room.4vris.mongodb.net/?retryWrites=true&w=majority&appName=room';
let db;

// Connect to MongoDB
MongoClient.connect(MONGO_URI)
    .then(client => {
        console.log('✅ Connected to MongoDB');
        db = client.db('foodiebot');
    })
    .catch(error => console.error('❌ MongoDB connection error:', error));

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
            '--single-process', // <- this one doesn't work in Windows
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
                // Save payment proof
                const paymentProof = {
                    orderId: session.pendingOrderId,
                    customerPhone: userPhone,
                    paymentMethod: 'UPI',
                    proofType: 'screenshot',
                    mediaData: media.data,
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
        
        // Initialize user cart if doesn't exist
        if (!userCarts.has(userPhone)) {
            userCarts.set(userPhone, []);
        }
        
        const userCart = userCarts.get(userPhone);
        
        // Add items to cart
        items.forEach(newItem => {
            const existingItem = userCart.find(cartItem => cartItem._id.toString() === newItem._id.toString());
            
            if (existingItem) {
                existingItem.quantity += newItem.quantity || 1;
            } else {
                userCart.push({
                    _id: newItem._id,
                    name: newItem.name,
                    price: newItem.price,
                    quantity: newItem.quantity || 1
                });
            }
        });
        
        // Send confirmation message to user
        const itemNames = items.map(item => item.name).join(', ');
        const confirmMessage = `✅ *Items added to your cart!*\n\n${itemNames}\n\n💬 Return to WhatsApp and type "cart" to view your order or "confirm" to place it.`;
        
        await client.sendMessage(`${userPhone}@c.us`, confirmMessage);
        
        res.json({ success: true, message: 'Items added to cart' });
    } catch (error) {
        console.error('Error adding to cart:', error);
        res.status(500).json({ error: error.message });
    }
});

// QR Code HTML page endpoint
app.get('/qr', (req, res) => {
    const qrPageHTML = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp QR Code - FoodieBot</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                margin: 0;
                padding: 20px;
                background: linear-gradient(135deg, #25D366, #128C7E);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .container {
                background: white;
                padding: 30px;
                border-radius: 15px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.2);
                text-align: center;
                max-width: 400px;
                width: 100%;
            }
            h1 {
                color: #25D366;
                margin-bottom: 20px;
            }
            .qr-container {
                margin: 20px 0;
                padding: 20px;
                background: #f5f5f5;
                border-radius: 10px;
            }
            .qr-code {
                max-width: 250px;
                width: 100%;
                height: auto;
            }
            .status {
                margin: 15px 0;
                padding: 10px;
                border-radius: 5px;
                font-weight: bold;
            }
            .status.connected {
                background: #d4edda;
                color: #155724;
                border: 1px solid #c3e6cb;
            }
            .status.disconnected {
                background: #f8d7da;
                color: #721c24;
                border: 1px solid #f5c6cb;
            }
            .status.loading {
                background: #fff3cd;
                color: #856404;
                border: 1px solid #ffeaa7;
            }
            .refresh-btn {
                background: #25D366;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 16px;
                margin-top: 10px;
            }
            .refresh-btn:hover {
                background: #128C7E;
            }
            .instructions {
                text-align: left;
                margin-top: 20px;
                padding: 15px;
                background: #e7f3ff;
                border-radius: 5px;
                border-left: 4px solid #25D366;
            }
            .loading {
                display: inline-block;
                width: 20px;
                height: 20px;
                border: 3px solid #f3f3f3;
                border-top: 3px solid #25D366;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🍽️ FoodieBot Connection</h1>
            
            <div id="status" class="status loading">
                <div class="loading"></div> Checking connection status...
            </div>
            
            <div id="qr-container" class="qr-container" style="display: none;">
                <p>📱 Scan this QR code with WhatsApp:</p>
                <img id="qr-code" class="qr-code" src="" alt="QR Code">
            </div>
            
            <button class="refresh-btn" onclick="checkStatus()">🔄 Refresh Status</button>
            
            <div class="instructions">
                <h3>📋 Instructions:</h3>
                <ol>
                    <li>Open WhatsApp on your phone</li>
                    <li>Go to <strong>Settings > Linked Devices</strong></li>
                    <li>Tap <strong>"Link a Device"</strong></li>
                    <li>Scan the QR code above</li>
                    <li>Wait for connection confirmation</li>
                </ol>
            </div>
        </div>

        <script>
            async function checkStatus() {
                try {
                    const response = await fetch('/api/status');
                    const data = await response.json();
                    const statusEl = document.getElementById('status');
                    const qrContainer = document.getElementById('qr-container');
                    
                    if (data.isAuthenticated) {
                        statusEl.className = 'status connected';
                        statusEl.innerHTML = '✅ WhatsApp Connected Successfully!';
                        qrContainer.style.display = 'none';
                    } else if (data.qrGenerated) {
                        statusEl.className = 'status loading';
                        statusEl.innerHTML = '📱 QR Code Ready - Please scan with WhatsApp';
                        qrContainer.style.display = 'block';
                        
                        // Load QR code image
                        const qrImg = document.getElementById('qr-code');
                        qrImg.src = '/api/qr?' + new Date().getTime(); // Cache busting
                    } else {
                        statusEl.className = 'status disconnected';
                        statusEl.innerHTML = '⏳ Generating QR Code...';
                        qrContainer.style.display = 'none';
                    }
                } catch (error) {
                    console.error('Error checking status:', error);
                    const statusEl = document.getElementById('status');
                    statusEl.className = 'status disconnected';
                    statusEl.innerHTML = '❌ Error checking connection status';
                }
            }
            
            // Check status every 3 seconds
            setInterval(checkStatus, 3000);
            
            // Initial check
            checkStatus();
        </script>
    </body>
    </html>
    `;
    
    res.send(qrPageHTML);
});

// API Routes
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
app.post('/api/generate-qr', async (req, res) => {
    try {
        if (botState.isAuthenticated) {
            res.json({ error: 'Already authenticated' });
            return;
        }
        
        // Destroy existing client and create new one
        await client.destroy();
        
        setTimeout(() => {
            client.initialize();
        }, 2000);
        
        res.json({ message: 'QR generation initiated' });
    } catch (error) {
        console.error('Error generating QR:', error);
        res.status(500).json({ error: error.message });
    }
});
// Orders API (continuing from where it was cut off)
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await db.collection('orders')
            .find({})
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get specific order
app.get('/api/orders/:orderId', async (req, res) => {
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
app.put('/api/orders/:orderId/status', async (req, res) => {
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
        
        // Get updated order
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
        
        if (statusMessages[status]) {
            const message = `📋 *Order Update - ${updatedOrder.orderId}*\n\n${statusMessages[status]}\n\nThank you for choosing FoodieBot! 🤖`;
            await client.sendMessage(`${updatedOrder.customerPhone}@c.us`, message);
        }
        
        res.json({ success: true, order: updatedOrder });
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ error: error.message });
    }
});

// Verify payment
app.put('/api/payments/:paymentId/verify', async (req, res) => {
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
        
        res.json({ success: true, verified });
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get payment proofs
app.get('/api/payments', async (req, res) => {
    try {
        const payments = await db.collection('payment_proofs')
            .find({})
            .sort({ timestamp: -1 })
            .limit(50)
            .toArray();
        
        res.json(payments);
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({ error: error.message });
    }
});

// Users API
app.get('/api/users', async (req, res) => {
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
app.get('/api/sessions', async (req, res) => {
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
app.post('/api/send-message', async (req, res) => {
    try {
        const { phone, message } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ error: 'Phone and message are required' });
        }
        
        await client.sendMessage(`${phone}@c.us`, message);
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Broadcast message to all users
app.post('/api/broadcast', async (req, res) => {
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
                await client.sendMessage(`${user.phone}@c.us`, message);
                successCount++;
                
                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
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
app.delete('/api/cart/:phone', async (req, res) => {
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
app.get('/api/cart/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;
        const cart = userCarts.get(phone) || [];
        res.json(cart);
    } catch (error) {
        console.error('Error fetching cart:', error);
        res.status(500).json({ error: error.message });
    }
});

// Dashboard endpoint
app.get('/dashboard', (req, res) => {
    const dashboardHTML = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>FoodieBot Dashboard</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: #f5f7fa;
                color: #333;
            }
            .header {
                background: linear-gradient(135deg, #25D366, #128C7E);
                color: white;
                padding: 20px;
                text-align: center;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .container {
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
            }
            .stats {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }
            .stat-card {
                background: white;
                padding: 20px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.05);
                text-align: center;
            }
            .stat-number {
                font-size: 2em;
                font-weight: bold;
                color: #25D366;
                margin-bottom: 10px;
            }
            .tabs {
                display: flex;
                background: white;
                border-radius: 10px;
                overflow: hidden;
                box-shadow: 0 2px 10px rgba(0,0,0,0.05);
                margin-bottom: 20px;
            }
            .tab {
                flex: 1;
                padding: 15px;
                text-align: center;
                cursor: pointer;
                border: none;
                background: white;
                font-size: 16px;
            }
            .tab.active {
                background: #25D366;
                color: white;
            }
            .tab-content {
                background: white;
                border-radius: 10px;
                padding: 20px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.05);
                min-height: 400px;
            }
            .tab-pane {
                display: none;
            }
            .tab-pane.active {
                display: block;
            }
            table {
                width: 100%;
                border-collapse: collapse;
            }
            th, td {
                padding: 12px;
                text-align: left;
                border-bottom: 1px solid #eee;
            }
            th {
                background: #f8f9fa;
                font-weight: 600;
            }
            .status {
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: bold;
            }
            .status.pending { background: #fff3cd; color: #856404; }
            .status.confirmed { background: #d4edda; color: #155724; }
            .status.delivered { background: #d1ecf1; color: #0c5460; }
            .status.cancelled { background: #f8d7da; color: #721c24; }
            .btn {
                padding: 8px 16px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                margin: 2px;
            }
            .btn-primary { background: #25D366; color: white; }
            .btn-danger { background: #dc3545; color: white; }
            .btn-success { background: #28a745; color: white; }
            .loading {
                text-align: center;
                padding: 40px;
                color: #666;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🍽️ FoodieBot Dashboard</h1>
            <p>Manage your WhatsApp food ordering bot</p>
        </div>
        
        <div class="container">
            <div class="stats" id="stats">
                <div class="stat-card">
                    <div class="stat-number" id="totalOrders">-</div>
                    <div>Total Orders</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="totalUsers">-</div>
                    <div>Total Users</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="pendingOrders">-</div>
                    <div>Pending Orders</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" id="botStatus">-</div>
                    <div>Bot Status</div>
                </div>
            </div>
            
            <div class="tabs">
                <button class="tab active" onclick="showTab('orders')">Orders</button>
                <button class="tab" onclick="showTab('users')">Users</button>
                <button class="tab" onclick="showTab('payments')">Payments</button>
                <button class="tab" onclick="showTab('broadcast')">Broadcast</button>
            </div>
            
            <div class="tab-content">
                <div id="orders" class="tab-pane active">
                    <h3>Recent Orders</h3>
                    <div id="ordersTable" class="loading">Loading orders...</div>
                </div>
                
                <div id="users" class="tab-pane">
                    <h3>Users</h3>
                    <div id="usersTable" class="loading">Loading users...</div>
                </div>
                
                <div id="payments" class="tab-pane">
                    <h3>Payment Verifications</h3>
                    <div id="paymentsTable" class="loading">Loading payments...</div>
                </div>
                
                <div id="broadcast" class="tab-pane">
                    <h3>Broadcast Message</h3>
                    <textarea id="broadcastMessage" placeholder="Enter your broadcast message..." rows="4" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 10px;"></textarea>
                    <button class="btn btn-primary" onclick="sendBroadcast()">Send Broadcast</button>
                    <div id="broadcastResult"></div>
                </div>
            </div>
        </div>

        <script>
            let currentData = {};
            
            function showTab(tabName) {
                // Hide all tab panes
                document.querySelectorAll('.tab-pane').forEach(pane => {
                    pane.classList.remove('active');
                });
                
                // Remove active class from all tabs
                document.querySelectorAll('.tab').forEach(tab => {
                    tab.classList.remove('active');
                });
                
                // Show selected tab pane
                document.getElementById(tabName).classList.add('active');
                
                // Add active class to clicked tab
                event.target.classList.add('active');
            }
            
            async function loadDashboard() {
                try {
                    // Load stats
                    const [orders, users, payments, status] = await Promise.all([
                        fetch('/api/orders').then(r => r.json()),
                        fetch('/api/users').then(r => r.json()),
                        fetch('/api/payments').then(r => r.json()),
                        fetch('/api/status').then(r => r.json())
                    ]);
                    
                    currentData = { orders, users, payments, status };
                    
                    // Update stats
                    document.getElementById('totalOrders').textContent = orders.length;
                    document.getElementById('totalUsers').textContent = users.length;
                    document.getElementById('pendingOrders').textContent = orders.filter(o => o.status === 'pending_payment' || o.status === 'confirmed').length;
                    document.getElementById('botStatus').textContent = status.isAuthenticated ? '✅' : '❌';
                    
                    // Load tables
                    loadOrdersTable(orders);
                    loadUsersTable(users);
                    loadPaymentsTable(payments);
                    
                } catch (error) {
                    console.error('Error loading dashboard:', error);
                }
            }
            
            function loadOrdersTable(orders) {
                const table = createTable([
                    'Order ID', 'Customer', 'Items', 'Total', 'Status', 'Payment', 'Date', 'Actions'
                ], orders.map(order => [
                    order.orderId,
                    order.customerName || order.customerPhone,
                    order.items.length + ' items',
                    '₹' + order.total,
                    '<span class="status ' + order.status + '">' + order.status + '</span>',
                    order.paymentStatus || 'pending',
                    new Date(order.createdAt).toLocaleString(),
                    '<button class="btn btn-primary" onclick="updateOrderStatus(\'' + order.orderId + '\', \'confirmed\')">Confirm</button>' +
                    '<button class="btn btn-success" onclick="updateOrderStatus(\'' + order.orderId + '\', \'delivered\')">Delivered</button>'
                ]));
                
                document.getElementById('ordersTable').innerHTML = table;
            }
            
            function loadUsersTable(users) {
                const table = createTable([
                    'Phone', 'Name', 'Address', 'Profile Complete', 'Joined'
                ], users.map(user => [
                    user.phone,
                    user.name || '-',
                    user.address || '-',
                    user.isProfileComplete ? '✅' : '❌',
                    new Date(user.createdAt).toLocaleString()
                ]));
                
                document.getElementById('usersTable').innerHTML = table;
            }
            
            function loadPaymentsTable(payments) {
                const table = createTable([
                    'Order ID', 'Customer', 'Method', 'Type', 'Status', 'Date', 'Actions'
                ], payments.map(payment => [
                    payment.orderId,
                    payment.customerPhone,
                    payment.paymentMethod,
                    payment.proofType,
                    payment.status,
                    new Date(payment.timestamp).toLocaleString(),
                    payment.status === 'pending_verification' ? 
                        '<button class="btn btn-success" onclick="verifyPayment(\'' + payment._id + '\', true)">Verify</button>' +
                        '<button class="btn btn-danger" onclick="verifyPayment(\'' + payment._id + '\', false)">Reject</button>' : '-'
                ]));
                
                document.getElementById('paymentsTable').innerHTML = table;
            }
            
            function createTable(headers, rows) {
                let html = '<table><thead><tr>';
                headers.forEach(header => {
                    html += '<th>' + header + '</th>';
                });
                html += '</tr></thead><tbody>';
                
                rows.forEach(row => {
                    html += '<tr>';
                    row.forEach(cell => {
                        html += '<td>' + cell + '</td>';
                    });
                    html += '</tr>';
                });
                
                html += '</tbody></table>';
                return html;
            }
            
            async function updateOrderStatus(orderId, status) {
                try {
                    const response = await fetch('/api/orders/' + orderId + '/status', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status })
                    });
                    
                    if (response.ok) {
                        alert('Order status updated successfully!');
                        loadDashboard();
                    } else {
                        alert('Error updating order status');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error updating order status');
                }
            }
            
            async function verifyPayment(paymentId, verified) {
                try {
                    const notes = verified ? 'Payment verified' : 'Payment rejected';
                    const response = await fetch('/api/payments/' + paymentId + '/verify', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ verified, notes })
                    });
                    
                    if (response.ok) {
                        alert('Payment ' + (verified ? 'verified' : 'rejected') + ' successfully!');
                        loadDashboard();
                    } else {
                        alert('Error updating payment status');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error updating payment status');
                }
            }
            
            async function sendBroadcast() {
                const message = document.getElementById('broadcastMessage').value;
                if (!message) {
                    alert('Please enter a message');
                    return;
                }
                
                try {
                    const response = await fetch('/api/broadcast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message })
                    });
                    
                    const result = await response.json();
                    document.getElementById('broadcastResult').innerHTML = 
                        '<div style="margin-top: 10px; padding: 10px; background: #d4edda; border-radius: 4px; color: #155724;">' +
                        result.message + '</div>';
                    
                    document.getElementById('broadcastMessage').value = '';
                } catch (error) {
                    console.error('Error:', error);
                    alert('Error sending broadcast');
                }
            }
            
            // Load dashboard on page load
            loadDashboard();
            
            // Refresh every 30 seconds
            setInterval(loadDashboard, 30000);
        </script>
    </body>
    </html>
    `;
    
    res.send(dashboardHTML);
});

// Initialize WhatsApp client
console.log('🚀 Starting FoodieBot...');
client.initialize();

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🎯 Server running on port ${PORT}`);
    console.log(`📱 QR Code: http://localhost:${PORT}/qr`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
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
