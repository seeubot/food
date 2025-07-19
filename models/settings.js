const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    shopName: { type: String, default: 'My Food Business' },
    shopLocation: {
        latitude: { type: Number, default: 0 },
        longitude: { type: Number, default: 0 }
    },
    deliveryRates: [{
        kms: { type: Number, required: true, min: 0 },
        amount: { type: Number, required: true, min: 0 }
    }]
});

module.exports = mongoose.model('Settings', settingsSchema);


