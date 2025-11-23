// backend/routes/qr.js
const express = require('express');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Production URL for scanning (your requirement B)
const PROD_UPLOAD_BASE = "http://10.77.156.116:3000/upload?shop=";

// Optional cache folder
const CACHE_DIR = path.join(__dirname, '..', 'qr_cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Get QR for a specific shop
router.get('/:shopId', async (req, res) => {
    try {
        const shopId = req.params.shopId;
        if (!shopId) return res.status(400).json({ error: "Missing shopId" });

        const finalUrl = `${PROD_UPLOAD_BASE}${shopId}`;
        const cachePath = path.join(CACHE_DIR, `${shopId}.png`);

        // Serve cached QR
        if (fs.existsSync(cachePath)) {
            const buf = fs.readFileSync(cachePath);
            return res.json({
                url: finalUrl,
                dataUrl: `data:image/png;base64,${buf.toString('base64')}`
            });
        }

        // Generate fresh QR
        const qrBuffer = await QRCode.toBuffer(finalUrl, {
            type: 'png',
            errorCorrectionLevel: 'H',
            margin: 2,
            width: 700
        });

        fs.writeFileSync(cachePath, qrBuffer);

        res.json({
            url: finalUrl,
            dataUrl: `data:image/png;base64,${qrBuffer.toString('base64')}`
        });

    } catch (err) {
        console.error("QR ERROR:", err);
        res.status(500).json({ error: "QR generation failed" });
    }
});

// Download the QR image
router.get('/:shopId/download', (req, res) => {
    try {
        const shopId = req.params.shopId;
        const cachePath = path.join(CACHE_DIR, `${shopId}.png`);

        if (!fs.existsSync(cachePath)) return res.status(404).send("QR not found");

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename=\"xigra_qr_${shopId}.png\"`);
        fs.createReadStream(cachePath).pipe(res);

    } catch (err) {
        console.error("QR Download ERROR:", err);
        res.status(500).send("Download failed");
    }
});

module.exports = router;
