// db.js
require('dotenv').config();

const mysql = require('mysql2/promise');

const db = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

// Cek koneksi
(async () => {
    try {
        const [rows] = await db.query('SELECT 1');
        console.log('✅ Connected to MySQL database!');
    } catch (error) {
        console.error('❌ DB connection error:', error.message);
    }
})();

module.exports = db;
