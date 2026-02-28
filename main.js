require("dotenv/config");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleGenAI } = require("@google/genai");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const ai = new GoogleGenAI({});

const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);

const client = new Client({ 
    authStrategy: new LocalAuth(), // LocalAuth agar sesi nya tersimpan (tidak minta qr lagi ketika di run ulang)
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

async function addSheet(datatransaksi) {
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle[new Date().toLocaleDateString("id-ID", {month: "long"})];
        await sheet.loadHeaderRow(2);

        let ids = [];

        for (const data of datatransaksi) {
            const id = "TX-" + Math.random().toString(36).substring(2, 7).toUpperCase();

            ids.push(id);
        
            await sheet.addRow({
                ID: id,
                Date: data.tanggal,
                Transactions: data.transaksi,
                Nominal: data.nominal,
                Cashflow: data.cashflow,
                Category: data.kategori,
            });
        }

        return ids;
    } catch (error) {
        throw new Error(`Error menambahkan data transaksi: ${error.message}`);
    }
};

async function deleteSheet(id) {
    try {
        if (!id || id.length === 0) return false;

        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle[new Date().toLocaleDateString("id-ID", {month: "long"})];
        await sheet.loadHeaderRow(2);

        const rows = await sheet.getRows();

        let found = false;

        for (let i = 0; i < id.length; i++) {
            const line = rows.find(row => row.get("ID") === id[i])

            if (line) {
                line.assign({
                    'ID': "",
                    'Date': "",
                    'Transactions': "",
                    'Nominal': "",
                    'Cashflow': "",
                    'Category': "",
                });
                await line.save();
                found = true;
            }

        }
        return found;
    } catch (error) {
        throw new Error(`Error menghapus data transaksi: ${error.message}`);
    }
};

async function editSheet(id, datatransaksi) {
    try {
        if (!id || id.length === 0) return false;

        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle[new Date().toLocaleDateString("id-ID", {month: "long"})];
        await sheet.loadHeaderRow(2);

        const rows = await sheet.getRows();

        const line = rows.find(row => row.get("ID") === id[0])

        if (line) {
            
            const data = {
                tanggal: datatransaksi[0].tanggal || line.get("Date"),
                transaksi: datatransaksi[0].transaksi || line.get("Transactions"),
                nominal: datatransaksi[0].nominal || line.get("Nominal"),
                cashflow: datatransaksi[0].cashflow || line.get("Cashflow"),
                kategori: datatransaksi[0].kategori || line.get("Category"),
            };

            line.assign({
                'Date': data.tanggal,
                'Transactions': data.transaksi,
                'Nominal': data.nominal,
                'Cashflow': data.cashflow,
                'Category': data.kategori,
            });
            await line.save();

            return data;
        }
        return false;
    } catch (error) {
        throw new Error(`Error mengedit data transaksi: ${error.message}`);
    }
};

async function aiResult(message) {
    try {
        const systemInstruction = `
Kamu adalah Asisten Keuangan WhatsApp.
WAJIB balas dengan JSON VALID saja. Tanpa markdown, backtick, atau teks tambahan.

Format:
{
 "intent": "add" | "edit" | "delete" | "chat",
 "message": string | null,
 "id": string[] | null,
 "data_transaksi": [{
   "tanggal": "YYYY-MM-DD" | null,
   "transaksi": string | null,
   "nominal": number | null,
   "cashflow": "Income" | "Spending" | null,
   "kategori": "Makan & Minum | Transportasi | Pulsa & Internet | Hiburan | Belanja | Tagihan | Pemasukan | Lainnya" | null
 }] | null
}

Intent Rules:
- add → isi data_transaksi, tangkap nama transaksi/barang SECARA LENGKAP dan DETAIL persis seperti deskripsi user, id=null, message=null
- edit → isi id (UPPERCASE) & data_transaksi, message=null
- delete → isi id (UPPERCASE), data_transaksi=null, message=null
- chat → isi message saja

Help Mode:
Jika user kirim "help", "bantuan", "cara pakai", atau bertanya fitur,
set intent="chat" dan isi message dengan panduan ramah + bullet points.
WAJIB sertakan format berikut:

- 📝 *Tambah Transaksi:* Cukup ketik natural (Contoh: "Beli nasi goreng 15rb" atau "Gaji bulanan masuk 2 juta").
- ✏️ *Edit Transaksi:* Sebutkan ID transaksi dan transaksi barunya (Contoh: "Edit TX-1A2B nominalnya jadi 20000").
- 🗑️ *Hapus Transaksi:* Sebutkan ID transaksinya (Contoh: "Hapus transaksi TX-1A2B").

Aturan Kategori:
- "Belanja": Gunakan ini untuk bahan mentah/sembako (seperti telur, beras, sayur), barang kebutuhan sehari-hari, dan barang pribadi.
- "Makan & Minum": HANYA gunakan ini untuk makanan/minuman SIAP SAJI atau jajan di luar (seperti ayam geprek, soto, nasi penyetan, roti, lauk jadi).
- "Transportasi": Untuk bensin, parkir, ojol, dll.
- "Lainnya": Untuk isi galon, beli buku, dll.
- Jika "Income" (mendapatkan uang), kategorinya jadikan "Pemasukan".

Parsing:
- 15rb=15000, 2jt=2000000
- ID HARUS UPPERCASE
- Tanpa tanggal → gunakan hari ini
- Income: gaji/dapat uang
- Spending: beli/bayar/tagihan

Hari ini: ${new Date().toISOString().split('T')[0]}`;
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-lite",
            contents: message,
            config: {
                systemInstruction: systemInstruction,
                responseMimeType: "application/json",
            }
        });

        const jsonResult = JSON.parse(response.text)
        return jsonResult;
    } catch (error) {        
        throw new Error(`Error AI : ${error.message}`);
    }
}
    
client.on('qr', qr => {
    qrcode.generate(qr, {small: true});
});

client.on('ready', () =>{
    console.log("Client is ready");
});

client.on('message',  async (msg) =>{
    try {
        if ((await msg.getContact()).number !== process.env.OWNER_NUMBER || (await msg.getChat()).isGroup) return;

        await msg.react("🔃")

        const categoryIcons = {"Makan & Minum": "🍽️","Transportasi": "🚗","Pulsa & Internet": "📶","Hiburan": "🎮","Belanja": "🛍️","Tagihan": "📄","Pemasukan": "💰"};
        const cashflowIcons = {"Income": "📈", "Spending": "📉"};

        const jsonResult = await aiResult(msg.body);
        if (jsonResult.intent === 'add') {
            const ids = await addSheet(jsonResult.data_transaksi);
            
            let messageReply = `📝 *TRANSAKSI BERHASIL DICATAT*\n`;
            
            jsonResult.data_transaksi.forEach((data, index) => {
                messageReply += `\n━━━━━━━━━━━━━━━━━━\n🆔 *ID:* \`${ids[index]}\`\n📅 *Date:* ${data.tanggal}\n📝 *Transaction:* ${data.transaksi}\n💰 *Nominal:* Rp ${data.nominal.toLocaleString('id-ID')}\n${cashflowIcons[data.cashflow] || "📊"} *Cashflow:* ${data.cashflow}\n${categoryIcons[data.kategori] || "📂"} *Category:*  ${data.kategori}\n━━━━━━━━━━━━━━━━━━`;
            });
            
            await msg.reply(messageReply.trim());
            await msg.react("✅");

        } else if (jsonResult.intent === 'edit') {
            if (jsonResult.data_transaksi === null) {
                await msg.reply("Mohon sertakan data transaksi yang baru untuk mengedit.");

            } else {
                const data = await editSheet(jsonResult.id, jsonResult.data_transaksi);
                if (data) {
                    let messageReply = `✏️ *TRANSAKSI BERHASIL DIPERBARUI*\n\n━━━━━━━━━━━━━━━━━━\n🆔 *ID:* \`${jsonResult.id[0]}\`\n📅 *Date:* ${data.tanggal}\n📝 *Transaction:* ${data.transaksi}\n💰 *Nominal:* Rp ${data.nominal.toLocaleString('id-ID')}\n${cashflowIcons[data.cashflow] || "📊"} *Cashflow:* ${data.cashflow}\n${categoryIcons [data.kategori] || "📂"} *Category:*  ${data.kategori}\n━━━━━━━━━━━━━━━━━━`;

                    await msg.reply(messageReply);
                    await msg.react("✏️");
                } else {
                    await msg.reply("Gagal mengedit transaksi. Pastikan ID yang diberikan benar dan coba lagi.");
                    await msg.react("❌");
                }
            }

        } else if (jsonResult.intent === 'delete') {
            if (await deleteSheet(jsonResult.id)) {
                let messageReply = `🗑️ *TRANSAKSI BERHASIL DIHAPUS*\n\nTransaksi dengan *ID* \`${jsonResult.id.join(", ")}\` telah berhasil dihapus.`;

                await msg.reply(messageReply);
                await msg.react("🗑️");

            } else {
                await msg.reply("Gagal menghapus transaksi. Pastikan ID yang diberikan benar dan coba lagi.");
                await msg.react("❌");
            }

        }  else if (jsonResult.intent === 'chat') {
            await msg.reply(jsonResult.message)
            await msg.react("💬");
        }

    } catch (error){
            console.error(error);
            await msg.reply("Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.");
            await msg.react("❌");
    }
});

client.initialize();