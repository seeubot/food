const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

// Clean up function to kill any existing Chrome processes
function cleanupChromeProcesses() {
    const { exec } = require('child_process');
    
    // Kill any existing Chrome processes
    exec('pkill -f chrome', () => {});
    exec('pkill -f chromium', () => {});
    exec('pkill -f "Google Chrome"', () => {});
    
    console.log('🧹 Cleaned up existing browser processes');
}

// Initialize with more robust configuration
function createClient() {
    return new Client({
        authStrategy: new LocalAuth({
            dataPath: './wwebjs_auth',
            clientId: 'support-bot'
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--disable-extensions',
                '--disable-default-apps',
                '--disable-component-extensions-with-background-pages',
                '--disable-background-networking',
                '--disable-sync',
                '--metrics-recording-only',
                '--no-report-upload',
                '--disable-breakpad',
                '--disable-crash-reporter',
                '--disable-domain-reliability',
                '--disable-component-update',
                '--user-data-dir=/tmp/chrome-user-data',
                '--remote-debugging-port=0'
            ],
            timeout: 30000,
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false
        }
    });
}

let client;
let isShuttingDown = false;
let initializationAttempts = 0;
const maxInitializationAttempts = 5;

// Support responses
const supportResponses = {
    'help': `🤖 *Support Bot Help*

Available commands:
• *help* - Show this help menu
• *hours* - Business hours
• *contact* - Contact information
• *faq* - Frequently asked questions
• *status* - Service status
• *human* - Connect with human support

Type any command to get started!`,

    'hours': `🕐 *Business Hours*

Monday - Friday: 9:00 AM - 6:00 PM
Saturday: 10:00 AM - 4:00 PM
Sunday: Closed

Timezone: UTC+0

We'll respond to your messages during business hours.`,

    'contact': `📞 *Contact Information*

📧 Email: support@yourcompany.com
📱 Phone: +1-234-567-8900
🌐 Website: https://yourcompany.com
📍 Address: 123 Business St, City, Country

For urgent matters, please call our phone number.`,

    'faq': `❓ *Frequently Asked Questions*

*Q: How do I reset my password?*
A: Visit our website and click "Forgot Password" or contact support.

*Q: How long does delivery take?*
A: Standard delivery is 3-5 business days.

*Q: What payment methods do you accept?*
A: We accept all major credit cards, PayPal, and bank transfers.

*Q: How can I track my order?*
A: You'll receive a tracking number via email once your order ships.

Need more help? Type *human* to connect with our support team.`,

    'status': `✅ *Service Status*

All systems operational:
• Website: ✅ Online
• Payment System: ✅ Online
• Email Support: ✅ Online
• Phone Support: ✅ Online

Last updated: ${new Date().toLocaleString()}

For real-time updates, visit our status page.`,

    'human': `👨‍💼 *Human Support*

I'm connecting you with our support team. Please wait while I transfer your conversation.

In the meantime, please provide:
• Your name
• Order number (if applicable)
• Brief description of your issue

Our team will respond within 2 hours during business hours.

Thank you for your patience! 🙏`
};

// Setup client event handlers
function setupClientEvents(client) {
    client.on('qr', (qr) => {
        console.log('📱 QR Code generated. Scan with WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Support Bot is ready!');
        console.log('Bot is now connected and listening for messages...');
        initializationAttempts = 0; // Reset attempts on successful connection
    });

    client.on('authenticated', () => {
        console.log('✅ Authentication successful!');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Authentication failed:', msg);
        console.log('💡 Try deleting the wwebjs_auth folder and restart');
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Client disconnected:', reason);
        if (!isShuttingDown) {
            console.log('🔄 Attempting to reconnect in 15 seconds...');
            setTimeout(() => {
                if (!isShuttingDown) {
                    initializeClient();
                }
            }, 15000);
        }
    });

    client.on('message', async (message) => {
        try {
            // Ignore group messages and status updates
            if (message.from.includes('@g.us') || message.isStatus) {
                return;
            }

            const chat = await message.getChat();
            const contact = await message.getContact();
            const messageBody = message.body.toLowerCase().trim();

            console.log(`📨 Message from ${contact.name || contact.number}: ${message.body}`);

            let response = '';

            // Check for specific commands
            if (supportResponses[messageBody]) {
                response = supportResponses[messageBody];
            } else if (messageBody.includes('hello') || messageBody.includes('hi') || messageBody.includes('hey')) {
                response = `👋 Hello ${contact.name || 'there'}! Welcome to our support bot.

I'm here to help you 24/7. Type *help* to see available commands or describe your issue and I'll assist you.

How can I help you today?`;
            } else if (messageBody.includes('thank')) {
                response = `You're welcome! 😊 

Is there anything else I can help you with today? Type *help* for more options.`;
            } else if (messageBody.includes('bye') || messageBody.includes('goodbye')) {
                response = `Goodbye! 👋 

Thank you for contacting us. If you need further assistance, feel free to message us anytime.

Have a great day! 🌟`;
            } else if (messageBody.includes('order') || messageBody.includes('delivery') || messageBody.includes('shipping')) {
                response = `📦 *Order & Delivery Support*

For order-related queries:
• Check your email for order confirmation
• Use tracking number to monitor delivery
• Standard delivery: 3-5 business days
• Express delivery: 1-2 business days

Need specific help with your order? Type *human* to connect with our team.`;
            } else if (messageBody.includes('payment') || messageBody.includes('refund') || messageBody.includes('billing')) {
                response = `💳 *Payment & Billing Support*

Payment issues:
• Check your payment method
• Verify billing address
• Contact your bank if payment declined

Refund requests:
• Refunds processed within 5-7 business days
• Original payment method will be credited

For billing disputes, type *human* for assistance.`;
            } else if (messageBody.includes('account') || messageBody.includes('login') || messageBody.includes('password')) {
                response = `🔐 *Account Support*

Account issues:
• Reset password on our website
• Check your email for verification
• Clear browser cache and cookies

Still having trouble? Type *human* to get personalized help from our team.`;
            } else {
                response = `🤖 I received your message: "${message.body}"

I'm still learning! For immediate help, try these commands:
• *help* - See all available commands
• *faq* - Common questions
• *human* - Connect with support team

Or describe your issue and I'll do my best to help!`;
            }

            await chat.sendMessage(response);
            console.log(`✅ Response sent to ${contact.name || contact.number}`);

        } catch (error) {
            console.error('❌ Error handling message:', error);
            try {
                const chat = await message.getChat();
                await chat.sendMessage('❌ Sorry, I encountered an error. Please try again or type *human* for assistance.');
            } catch (sendError) {
                console.error('❌ Error sending error message:', sendError);
            }
        }
    });

    client.on('error', (error) => {
        console.error('❌ Client error:', error);
    });
}

// Initialize client with retry logic
async function initializeClient() {
    if (isShuttingDown) return;

    try {
        initializationAttempts++;
        console.log(`🚀 Starting WhatsApp Support Bot (attempt ${initializationAttempts}/${maxInitializationAttempts})...`);

        if (initializationAttempts > maxInitializationAttempts) {
            console.error('❌ Maximum initialization attempts reached. Exiting...');
            process.exit(1);
        }

        // Clean up any existing processes
        cleanupChromeProcesses();

        // Wait a bit before creating client
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Destroy existing client if it exists
        if (client) {
            try {
                await client.destroy();
            } catch (e) {
                console.log('Previous client cleanup completed');
            }
        }

        // Create new client
        client = createClient();
        setupClientEvents(client);

        // Initialize with timeout
        const initPromise = client.initialize();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Initialization timeout')), 60000);
        });

        await Promise.race([initPromise, timeoutPromise]);

    } catch (error) {
        console.error('❌ Failed to initialize client:', error.message);
        
        if (!isShuttingDown) {
            const retryDelay = Math.min(10000 * initializationAttempts, 60000);
            console.log(`🔄 Retrying in ${retryDelay/1000} seconds...`);
            setTimeout(() => {
                if (!isShuttingDown) {
                    initializeClient();
                }
            }, retryDelay);
        }
    }
}

// Create auth directory if it doesn't exist
const authDir = './wwebjs_auth';
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

// Clean up tmp directory
const tmpDir = '/tmp/chrome-user-data';
if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// Graceful shutdown
const shutdown = async () => {
    console.log('\n🔄 Shutting down bot...');
    isShuttingDown = true;
    
    try {
        if (client) {
            await client.destroy();
        }
        cleanupChromeProcesses();
        console.log('✅ Bot shut down successfully');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        cleanupChromeProcesses();
        process.exit(1);
    }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start the bot
console.log('🤖 WhatsApp Support Bot starting...');
initializeClient();
