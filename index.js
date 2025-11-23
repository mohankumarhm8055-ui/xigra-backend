// ======================================================
// XIGRA+ BACKEND (CLEAN + UPGRADED + QR SUPPORT)
// ======================================================

const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const fs        = require('fs');
const path      = require('path');
const QRCode    = require('qrcode');
const cron      = require('node-cron');
const crypto    = require('crypto');
const JSONdb    = require('simple-json-db');
const CryptoJS  = require("crypto-js");

const app = express();

// ------------------------------------------------------
// MIDDLEWARE
// ------------------------------------------------------
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cors());

// ------------------------------------------------------
// DATABASE INIT
// ------------------------------------------------------
const dbPath = path.join(__dirname, 'db.json');
const db = new JSONdb(dbPath);

if (!db.has('shops')) db.set('shops', []);
if (!db.has('files')) db.set('files', []);

// ------------------------------------------------------
// DIRECTORIES
// ------------------------------------------------------
const uploadDir = path.join(__dirname, 'uploads');
const shopUploadDir = path.join(__dirname, 'shop_uploads');
const qrCacheDir = path.join(__dirname, 'qr_cache');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(shopUploadDir)) fs.mkdirSync(shopUploadDir);
if (!fs.existsSync(qrCacheDir)) fs.mkdirSync(qrCacheDir);

// ------------------------------------------------------
// MULTER (Encrypted .enc file storage)
// ------------------------------------------------------
const storageEnc = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, __, cb) => {
        const id = crypto.randomUUID().slice(0, 8);
        cb(null, `${Date.now()}-${id}.enc`);
    }
});
const uploadEnc = multer({ storage: storageEnc });

// Utility
const now = () => Date.now();

// ======================================================
// 1) SHOP REGISTRATION + QR GENERATION
// ======================================================
app.post('/api/register', async (req, res) => {
    const { shopName } = req.body;
    if (!shopName) return res.status(400).json({ error: "shopName required" });

    const shopId = "SHOP-" + crypto.randomUUID().slice(0, 6).toUpperCase();
    const shops = db.get('shops');

    shops.push({
        id: shopId,
        name: shopName,
        createdAt: new Date().toISOString()
    });
    db.set('shops', shops);

    // PRODUCTION SCAN URL
    const scanURL = `https://xigra.in/upload?shop=${shopId}`;

    try {
        const qr = await QRCode.toDataURL(scanURL);
        res.json({ shop: { id: shopId, name: shopName }, url: scanURL, qr });
    } catch {
        res.json({ shop: { id: shopId, name: shopName }, url: scanURL, qr: null });
    }
});

// ======================================================
// 2) PERMANENT QR SYSTEM (PHONEPE STYLE)
// ======================================================
app.get('/api/qr/:shopId', async (req, res) => {
    try {
        const shopId = req.params.shopId;
        const finalURL = `https://xigra.in/upload?shop=${shopId}`;
        const filePath = path.join(qrCacheDir, `${shopId}.png`);

        if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            return res.json({
                url: finalURL,
                dataUrl: `data:image/png;base64,${buf.toString('base64')}`
            });
        }

        const qrBuf = await QRCode.toBuffer(finalURL, {
            errorCorrectionLevel: "H",
            width: 700,
            margin: 2
        });

        fs.writeFileSync(filePath, qrBuf);

        return res.json({
            url: finalURL,
            dataUrl: `data:image/png;base64,${qrBuf.toString('base64')}`
        });

    } catch (err) {
        console.error("QR ERROR:", err);
        res.status(500).json({ error: "QR generation failed" });
    }
});

// QR Download
app.get('/api/qr/:shopId/download', (req, res) => {
    try {
        const shopId = req.params.shopId;
        const filePath = path.join(qrCacheDir, `${shopId}.png`);

        if (!fs.existsSync(filePath)) return res.status(404).send("QR not found");

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `attachment; filename="xigra_qr_${shopId}.png"`);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        res.status(500).send("Download failed");
    }
});

// ======================================================
// 3) ENCRYPTED FILE UPLOAD
// ======================================================
app.post('/api/upload-encrypted', uploadEnc.single('file'), (req, res) => {
    try {
        const { shopId, originalName } = req.body;
        const file = req.file;

        if (!shopId || !originalName || !file)
            return res.status(400).json({ error: "Missing shopId/originalName/file" });

        const files = db.get('files');
        const fileId = crypto.randomUUID().slice(0, 8);

        files.push({
            id: fileId,
            shopId,
            originalName,
            path: `uploads/${file.filename}`,
            status: "locked",
            size: file.size,
            createdAt: now()
        });

        db.set('files', files);

        res.json({ status: "ok", fileId });
    } catch (err) {
        console.error("UPLOAD ERROR:", err);
        res.status(500).json({ error: "Upload failed" });
    }
});

// ======================================================
// 4) FILE LIST
// ======================================================
app.get('/api/files/:shopId', (req, res) => {
    const shopId = req.params.shopId;
    let files = db.get('files').filter(f => f.shopId === shopId);

    files.sort((a, b) => b.createdAt - a.createdAt);
    res.json(files);
});

// ======================================================
// 5) FILE PREVIEW
// ======================================================
app.get('/preview/:shopId/:filename', (req, res) => {
    const { shopId, filename } = req.params;
    const filePath = path.join(shopUploadDir, shopId, filename);

    if (!fs.existsSync(filePath)) return res.status(404).send("Preview not found");
    res.sendFile(filePath);
});

// ======================================================
// 6) FILE UNLOCK (AES DECRYPTION)
// ======================================================
app.post('/api/unlock/:fileId', (req, res) => {
    try {
        const fileId = req.params.fileId;
        const files = db.get('files');
        const file = files.find(f => f.id === fileId);

        if (!file) return res.status(404).json({ error: "File not found" });

        const encPath = path.join(__dirname, file.path);
        if (!fs.existsSync(encPath)) return res.status(404).json({ error: "Encrypted file missing" });

        const encText = fs.readFileSync(encPath, "utf8");
        const key = "XIGRA_SECRET_KEY";

        const decryptedBytes = CryptoJS.AES.decrypt(encText, key);
        const decryptedBase64 = decryptedBytes.toString(CryptoJS.enc.Utf8);

        const buffer = Buffer.from(decryptedBase64, "base64");

        const outDir = path.join(shopUploadDir, file.shopId);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        fs.writeFileSync(path.join(outDir, file.originalName), buffer);

        file.status = "unlocked";
        db.set('files', files);

        res.json({ status: "ok" });
    } catch (err) {
        console.error("DECRYPT ERROR:", err);
        res.status(500).json({ error: "Decrypt failed" });
    }
});

// ======================================================
// 7) MARK PRINTED
// ======================================================
app.post('/api/mark-printed/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const files = db.get('files');
    const file = files.find(f => f.id === fileId);

    if (!file) return res.status(404).json({ error: "File not found" });

    file.status = "printed";
    file.printedAt = now();
    db.set('files', files);

    res.json({ status: "ok" });
});

// ======================================================
// 8) DELETE FILE
// ======================================================
app.post('/api/delete/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    let files = db.get('files');
    const file = files.find(f => f.id === fileId);

    if (!file) return res.status(404).json({ error: "File not found" });

    // Delete enc
    try {
        const encPath = path.join(__dirname, file.path);
        if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
    } catch {}

    // Delete unlocked
    try {
        const outPath = path.join(shopUploadDir, file.shopId, file.originalName);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}

    files = files.filter(f => f.id !== fileId);
    db.set('files', files);

    res.json({ status: "ok" });
});

// ======================================================
// 9) CRON AUTO DELETE (Expired Files)
// ======================================================
cron.schedule("* * * * *", () => {
    const TTL = 10 * 60 * 1000; // 10 minutes
    const time = now();
    const files = db.get('files');
    const keep = [];

    files.forEach(f => {
        if (time - f.createdAt > TTL) {
            try {
                const encPath = path.join(__dirname, f.path);
                if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
            } catch {}

            try {
                const outPath = path.join(shopUploadDir, f.shopId, f.originalName);
                if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            } catch {}

        } else keep.push(f);
    });

    db.set('files', keep);
});

// ======================================================
// START SERVER
// ======================================================
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 XIGRA+ Backend running at http://localhost:${PORT}`);
});
