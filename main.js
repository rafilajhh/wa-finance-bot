require("dotenv/config");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const OpenAI = require("openai");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const ai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

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

const history = [];

async function addSheet(jsonResult, month) {
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle[month];
        await sheet.loadHeaderRow(2);

        for (let i = 0; i < jsonResult.data_transaksi.length; i++) {
            const data = jsonResult.data_transaksi[i];
            await sheet.addRow({
                'ID': jsonResult.id[i],
                'Date': data.tanggal,
                'Transactions': data.transaksi,
                'Nominal': data.nominal,
                'Cashflow': data.cashflow,
                'Category': data.kategori,
            });
        }

    } catch (error) {
        throw new Error(`Error menambahkan data transaksi: ${error.message}`);
    }
};

async function deleteSheet(id, month) {
    try {
        if (!id || id.length === 0) return false;

        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle[month];
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

async function editSheet(id, datatransaksi, month) {
    try {
        if (!id || id.length === 0) return false;

        await doc.loadInfo(); 
        const sheet = doc.sheetsByTitle[month];

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
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

        const systemInstruction = `
Kamu adalah Asisten Keuangan WhatsApp.
WAJIB balas dengan JSON VALID saja. Tanpa markdown, backtick, komentar, atau teks tambahan apapun.

=== FORMAT OUTPUT ===
{
  "intent": "add" | "edit" | "delete" | "chat",
  "message": string | null,
  "id": string[] | null,
  "month": "Januari" | "Februari" | "Maret" | "April" | "Mei" | "Juni" | "Juli" | "Agustus" | "September" | "Oktober" | "November" | "Desember" | null,
  "data_transaksi": [
    {
      "tanggal": "YYYY-MM-DD" | null,
      "transaksi": string | null,
      "nominal": number | null,
      "cashflow": "Income" | "Spending" | null,
      "kategori": "Makan & Minum" | "Transportasi" | "Pulsa & Internet" | "Hiburan" | "Belanja" | "Tagihan" | "Pemasukan" | "Lainnya" | null
    }
  ] | null
}

=== INTENT RULES ===
- add     → id=null, message=null, data_transaksi diisi lengkap, month=bulan transaksi (default bulan sekarang)
- edit    → id=["TX-XXXXX"] (UPPERCASE), data_transaksi diisi field yang diubah saja (sisanya null), message=null, month=bulan transaksi
- delete  → id=["TX-XXXXX", ...] (UPPERCASE), data_transaksi=null, message=null, month=bulan transaksi
- chat    → message diisi, id=null, data_transaksi=null, month=null

=== VALIDASI WAJIB ===
- nominal HARUS berupa angka bulat positif, BUKAN string. Contoh: 15000 bukan "15000" atau "15rb"
- id HARUS array of string meskipun hanya 1 ID. Contoh: ["TX-A1B2C"] bukan "TX-A1B2C"
- tanggal HARUS format YYYY-MM-DD atau null. Contoh: "2026-03-21"
- cashflow HARUS persis "Income" atau "Spending", huruf besar di awal
- kategori HARUS salah satu dari nilai yang tersedia, tidak boleh nilai lain
- month HARUS nama bulan dalam Bahasa Indonesia sesuai list, tidak boleh angka atau singkatan
- Jika ada field yang tidak diketahui, isi null. JANGAN mengarang nilai.

=== PARSING NOMINAL ===
- k / rb / ribu = × 1.000 → 15rb = 15000
- jt / juta = × 1.000.000 → 2jt = 2000000
- Nominal WAJIB bilangan bulat, tanpa desimal

=== ATURAN KATEGORI ===
- "Makan & Minum"   : makanan/minuman SIAP SAJI, jajan di luar (ayam geprek, kopi, bubble tea, dll)
- "Belanja"         : bahan mentah, sembako, kebutuhan rumah tangga, barang pribadi (telur, sabun, dll)
- "Transportasi"    : bensin, parkir, ojol, tol, tiket transportasi
- "Pulsa & Internet": pulsa, paket data, wifi
- "Hiburan"         : game, streaming, nonton, dll
- "Tagihan"         : listrik, air, cicilan, dll
- "Pemasukan"       : semua transaksi Income WAJIB kategori ini
- "Lainnya"         : isi galon, beli buku, dan hal yang tidak masuk kategori lain

=== ATURAN CASHFLOW ===
- "Income"  : menerima/mendapat uang (gaji, transfer masuk, jual barang, dll)
- "Spending": mengeluarkan uang (beli, bayar, transfer keluar, dll)
- Jika cashflow "Income" → kategori WAJIB "Pemasukan"

=== ATURAN TANGGAL ===
- Jika user tidak menyebut tanggal → gunakan hari ini: ${today}
- Jika user menyebut hari (misal "Senin") → hitung mundur ke hari tersebut dari hari ini
- Format SELALU YYYY-MM-DD

=== MULTI TRANSAKSI ===
- Jika user menyebut beberapa transaksi sekaligus → data_transaksi berisi lebih dari 1 objek
- Contoh: "beli nasi 15rb sama es teh 5rb" → 2 item di data_transaksi

=== HELP MODE ===
Jika user kirim "help", "bantuan", "cara pakai", atau bertanya fitur → intent="chat", isi message dengan:

Halo! Saya asisten keuangan WhatsApp kamu.

📝 *Tambah Transaksi*
Ketik natural, contoh:
- "Beli nasi goreng 15rb"
- "Gaji bulanan masuk 2 juta"
- "Beli bensin 50rb sama parkir 3rb"

✏️ *Edit Transaksi*
Sebutkan ID dan perubahannya, contoh:
- "Edit TX-A1B2C nominalnya jadi 20000"
- "Ubah kategori TX-A1B2C jadi Hiburan"

🗑️ *Hapus Transaksi*
Sebutkan ID-nya, contoh:
- "Hapus TX-A1B2C"
- "Hapus TX-A1B2C dan TX-D3E4F"

Setiap transaksi yang dicatat akan mendapat ID unik (TX-XXXXX) yang bisa dipakai untuk edit atau hapus.`;

        const response = await ai.chat.completions.create({
            model: "arcee-ai/trinity-large-preview:free",
            messages: [
                {role: "system", content: systemInstruction},
                ...history,
                {role: "user", content: message}
            ],
            response_format: {type: "json_object"},
            plugins: [
                {id: "response-healing"}
            ]
        });

        const text = response.choices[0].message.content;
        const parsed = JSON.parse(text);

        if (parsed.intent === "add") {
            parsed.id = [];

            for (const data of parsed.data_transaksi) {
                const id = "TX-" + Math.random().toString(36).substring(2, 7).toUpperCase();
                parsed.id.push(id);
            }
        }

        history.push({role:"user", content:message});
        history.push({role:"assistant", content:JSON.stringify(parsed)});

        console.log("AI Response:", parsed);
        return parsed;
        
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
        if ((await msg.getContact()).number !== process.env.OWNER_NUMBER || (await msg.getChat()).isGroup) {
            return;
        }

        while (history.length > 10) {
            history.shift();
        }

        await msg.react("🔃")
        
        const categoryIcons = {"Makan & Minum": "🍽️","Transportasi": "🚗","Pulsa & Internet": "📶","Hiburan": "🎮","Belanja": "🛍️","Tagihan": "📄","Pemasukan": "💰"};
        const cashflowIcons = {"Income": "📈", "Spending": "📉"};

        const jsonResult = await aiResult(msg.body);
        if (jsonResult.intent === 'add') {
            await addSheet(jsonResult, jsonResult.month);
            
            let messageReply = `📝 *TRANSAKSI BERHASIL DICATAT*\n`;
            
            jsonResult.data_transaksi.forEach((data, index) => {
                messageReply += `\n━━━━━━━━━━━━━━━━━━\n🆔 *ID:* \`${jsonResult.id[index]}\`\n📅 *Date:* ${data.tanggal}\n📝 *Transaction:* ${data.transaksi}\n💰 *Nominal:* Rp ${data.nominal.toLocaleString('id-ID')}\n${cashflowIcons[data.cashflow] || "📊"} *Cashflow:* ${data.cashflow}\n${categoryIcons[data.kategori] || "📂"} *Category:*  ${data.kategori}\n━━━━━━━━━━━━━━━━━━`;
            });
            
            await msg.reply(messageReply.trim());
            await msg.react("✅");

        } else if (jsonResult.intent === 'edit') {
            if (jsonResult.data_transaksi === null) {
                await msg.reply("Mohon sertakan data transaksi yang baru untuk mengedit.");
                
            } else {
                const data = await editSheet(jsonResult.id, jsonResult.data_transaksi, jsonResult.month);
                if (data) {
                    let messageReply = `✏️ *TRANSAKSI BERHASIL DIPERBARUI*\n\n━━━━━━━━━━━━━━━━━━\n🆔 *ID:* \`${jsonResult.id[0]}\`\n📅 *Date:* ${data.tanggal}\n📝 *Transaction:* ${data.transaksi}\n💰 *Nominal:* ${data.nominal.toLocaleString('id-ID')}\n${cashflowIcons[data.cashflow] || "📊"} *Cashflow:* ${data.cashflow}\n${categoryIcons[data.kategori] || "📂"} *Category:*  ${data.kategori}\n━━━━━━━━━━━━━━━━━━`;

                    await msg.reply(messageReply);
                    await msg.react("✏️");
                } else {
                    await msg.reply("Gagal mengedit transaksi. Pastikan ID yang diberikan benar dan coba lagi.");
                    await msg.react("❌");
                }
            }

        } else if (jsonResult.intent === 'delete') {
            if (await deleteSheet(jsonResult.id, jsonResult.month)) {
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