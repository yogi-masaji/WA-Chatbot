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

const db2 = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB2_DATABASE
});

(async () => {
    try {
        const [rows] = await db.query('SELECT 1');
        console.log('✅ DB connection successful:', rows);
        const [rows2] = await db2.query('SELECT 1');
        console.log('✅ DB2 connection successful:', rows2);
    } catch (error) {
        console.error('❌ DB connection error:', error.message);
    }
})();



module.exports = {db, db2};
