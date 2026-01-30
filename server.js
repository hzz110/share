const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies (optional, but good practice)
app.use(express.json());

// Custom Logging Middleware
app.use((req, res, next) => {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    
    // Get IP address
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    // Clean up IP format (remove IPv6 prefix if present)
    if (ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
    }
    
    // Log to console
    console.log(`[${now}] 访问者IP: ${ip} | 请求: ${req.method} ${req.url} | User-Agent: ${req.headers['user-agent']}`);
    
    // Optional: Append to a log file
    const logLine = `${now} | IP: ${ip} | ${req.method} ${req.url} | ${req.headers['user-agent']}\n`;
    fs.appendFile(path.join(__dirname, 'access.log'), logLine, (err) => {
        if (err) console.error('Failed to write to log file:', err);
    });

    next();
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==================================================`);
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Local LAN access: http://<Your-LAN-IP>:${PORT}`);
    console.log(`Access logs will be shown below and saved to access.log`);
    console.log(`==================================================\n`);
});
