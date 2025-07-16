const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// Configuration strategies to try in order
const configurations = [
    // Strategy 1: Minimal configuration
    {
        name: 'Minimal',
        config: {
            authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                timeout: 30000
            }
        }
    },
    
    // Strategy 2: Basic configuration
    {
        name: 'Basic',
        config: {
            authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ],
                timeout: 0
            }
        }
    },
    
    // Strategy 3: Single process
    {
        name: 'Single Process',
        config: {
            authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--single-process',
                    '--no-zygote'
                ],
                timeout: 45000
            }
        }
    },
    
    // Strategy 4: With specific user data dir
    {
        name: 'User Data Dir',
        config: {
            authStrategy: new LocalAuth({ dataPath: './wwebjs_auth' }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--user-data-dir=/tmp/chrome-' + Date.now(),
                    '--disable-dev-shm-usage'
                ],
                timeout: 60000
            }
        }
    }
];

let currentConfigIndex = 0;
let client;
let isShuttingDown = false;

// Support responses
const supportResponses = {
    'help': `🤖 *Support Bot Help*

Available commands:
• help - Show this help menu
• hours - Business hours
• contact - Contact information
• faq - Common questions
• status - Service status
• human - Connect with support

Type any command to get started!`,
    
    'hours': `🕐 *Business Hours*
Monday - Friday: 9:00 AM - 6:00 PM
Saturday: 10:00 AM - 4:00 PM
Sunday: Closed

We'll respond during business hours.`,
    
    'contact': `📞 *Contact Information*
📧 Email: support@yourcompany.com
📱 Phone: +1-234-567-8900
🌐 Website: https://yourcompany.com

For urgent matters, please call us.`,
    
    'faq': `❓ *Common Questions*
• Password reset: Visit our website
• Delivery: 3-5 business days
• Payments: All major cards accepted
• Tracking: Check your email for details

Type 'human' for personal assistance.`,
    
    'status': `✅ *Service Status*
All systems operational
Last updated: ${new Date().toLocaleString()}`,
    
    'human': `👨‍💼 *Human Support*
Connecting you with our team...
Please provide your name and issue description.
Response time: 2 hours during business hours.`
};

// Clean up function
function cleanup() {
    try {
        const { exec } = require('child_process');
        exec('pkill -f chrome', () => {});
        exec('pkill -f chromium', () => {});
        
        // Clean up temp directories
        const tmpDirs = ['/tmp/chrome-user-data', '/tmp/puppeteer_dev_chrome_profile-'];
        tmpDirs.forEach(dir => {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });
        
        console.log('🧹 Cleanup completed');
    } catch (error) {
        console.log('Cleanup completed with minor errors');
    }
}

// Setup event handlers
function setupEvents(client) {
    client.on('qr', (qr) => {
        console.log('📱 Scan this QR code with WhatsApp:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('✅ Bot is ready and connected!');
        currentConfigIndex = 0; // Reset on success
    });

    client.on('authenticated', () => {
        console.log('✅ Authentication successful');
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Auth failed:', msg);
        console.log('💡 Delete wwebjs_auth folder and try again');
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Disconnected:', reason);
        if (!isShuttingDown) {
            setTimeout(() => initializeBot(), 10000);
        }
    });

    client.on('message', handleMessage);
    
    client.on('error', (error) => {
        console.error('❌ Client error:', error.message);
    });
}

// Message handler
async function handleMessage(message) {
    try {
        if (message.from.includes('@g.us') || message.isStatus) {
            return;
        }

        const chat = await message.getChat();
        const contact = await message.getContact();
        const messageBody = message.body.toLowerCase().trim();

        console.log(`📨 ${contact.name || contact.number}: ${message.body}`);

        let response = '';

        if (supportResponses[messageBody]) {
            response = supportResponses[messageBody];
        } else if (messageBody.includes('hello') || messageBody.includes('hi')) {
            response = `👋 Hello! I'm your support bot. Type 'help' for available commands.`;
        } else if (messageBody.includes('thank')) {
            response = `You're welcome! 😊 Anything else I can help with?`;
        } else if (messageBody.includes('bye')) {
            response = `Goodbye! 👋 Contact us anytime for support.`;
        } else {
            response = `I received: "${message.body}"\n\nType 'help' for commands or 'human' for personal assistance.`;
        }

        await chat.sendMessage(response);
        console.log('✅ Response sent');

    } catch (error) {
        console.error('❌ Message error:', error.message);
    }
}

// Initialize bot with fallback strategies
async function initializeBot() {
    if (isShuttingDown) return;

    const config = configurations[currentConfigIndex];
    console.log(`🚀 Trying configuration: ${config.name} (${currentConfigIndex + 1}/${configurations.length})`);

    try {
        // Cleanup before each attempt
        cleanup();
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Destroy existing client
        if (client) {
            try {
                await client.destroy();
            } catch (e) {}
        }

        // Create new client
        client = new Client(config.config);
        setupEvents(client);

        // Initialize with timeout
        await Promise.race([
            client.initialize(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 90000))
        ]);

    } catch (error) {
        console.error(`❌ ${config.name} strategy failed:`, error.message);
        
        // Try next configuration
        currentConfigIndex++;
        if (currentConfigIndex < configurations.length) {
            console.log(`🔄 Trying next strategy in 5 seconds...`);
            setTimeout(() => initializeBot(), 5000);
        } else {
            console.log('❌ All strategies failed. Retrying from beginning in 30 seconds...');
            currentConfigIndex = 0;
            setTimeout(() => initializeBot(), 30000);
        }
    }
}

// Create auth directory
if (!fs.existsSync('./wwebjs_auth')) {
    fs.mkdirSync('./wwebjs_auth', { recursive: true });
}

// Graceful shutdown
async function shutdown() {
    console.log('\n🔄 Shutting down...');
    isShuttingDown = true;
    
    try {
        if (client) {
            await client.destroy();
        }
        cleanup();
        process.exit(0);
    } catch (error) {
        cleanup();
        process.exit(1);
    }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Global error handlers
process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error.message);
});

// Start the bot
console.log('🤖 WhatsApp Support Bot starting...');
initializeBot();
