    require('dotenv').config();
    const mongoose = require('mongoose');
    const Admin = require('./models/admin'); // Path to your Admin model

    const MONGODB_URI = process.env.MONGODB_URI;

    if (!MONGODB_URI) {
        console.error('Error: MONGODB_URI is not defined in your .env file.');
        process.exit(1);
    }

    const username = 'admin'; // You can change this username
    const password = 'password123'; // CHANGE THIS TO A STRONG, SECURE PASSWORD!

    async function createAdminUser() {
        try {
            await mongoose.connect(MONGODB_URI);
            console.log('MongoDB connected for admin creation.');

            let admin = await Admin.findOne({ username });

            if (admin) {
                console.log(`Admin user '${username}' already exists.`);
                // You could offer to update password here if needed
                // admin.password = password; // This would re-hash the new password on save
                // await admin.save();
                // console.log(`Password for '${username}' updated.`);
            } else {
                admin = new Admin({ username, password });
                await admin.save();
                console.log(`Admin user '${username}' created successfully with password '${password}'.`);
                console.log('Please change this password immediately after logging in for the first time!');
            }
        } catch (error) {
            console.error('Error creating admin user:', error);
        } finally {
            mongoose.connection.close();
            console.log('MongoDB connection closed.');
        }
    }

    createAdminUser();
    ```

