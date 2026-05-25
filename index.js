const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    getContentType
} = require("@whiskeysockets/baileys");

const {
    Image
} = require("node-webpmux");
const pino = require("pino");
const {
    Boom
} = require("@hapi/boom");
const fs = require("fs");
const {
    exec
} = require("child_process");
const qrcode = require("qrcode-terminal");
const moment = require("moment-timezone");
require("moment-duration-format");
moment.locale("id");

const crypto = require("crypto");
const {
    findParticipantByNumber
} = require("./lidHelper");

const activeAdminTimeouts = new Map();
const kickQueue = new Set();

let dbAntiSticker = fs.existsSync("./antisticker.json") ?
    JSON.parse(fs.readFileSync("./antisticker.json", "utf8")) : {};

const saveAnti = () =>
    fs.writeFileSync("./antisticker.json", JSON.stringify(dbAntiSticker));

let dbJadiAdmin = fs.existsSync("./jadiadmin.json") ?
    JSON.parse(fs.readFileSync("./jadiadmin.json", "utf8")) : {};

const saveJadiAdmin = () =>
    fs.writeFileSync("./jadiadmin.json", JSON.stringify(dbJadiAdmin));

const startTime = Date.now();

let dbNama = fs.existsSync("./nama_user.json") ?
    JSON.parse(fs.readFileSync("./nama_user.json", "utf8")) : {};

let dbBanned = fs.existsSync("./banned.json") ?
    JSON.parse(fs.readFileSync("./banned.json", "utf8")) : [];

const saveBanned = () =>
    fs.writeFileSync("./banned.json", JSON.stringify(dbBanned));

/* ----------- STATUS TRACKING ---------- */
let countdownFinished = false;
let botConnectionOpen = false;

const getParticipantJids = (participants) => {
    return participants.map((p) => p.id);
};


/* ----------- ID OWNER BOT ----------- */
const ownerId = "133410643255493";


/* ------- CHECK PENDING ADMIN ------- */
async function checkPendingAdmin(conn) {
    // Tunggu 3 detik agar socket benar-benar stabil setelah reconnect
    await new Promise(resolve => setTimeout(resolve, 3000));

    const now = Date.now();
    for (const jid in dbJadiAdmin) {
        const data = dbJadiAdmin[jid];

        // Cek jika waktu sudah lewat (termasuk yang lewat saat bot offline)
        if (now >= data.endTime) {
            try {
                // Eksekusi demote
                await conn.groupParticipantsUpdate(data.groupId, [jid], 'demote');

                const waktuBerakhir = moment(data.endTime).tz("Asia/Jakarta").format("dddd, DD/MM/YYYY HH:mm:ss");

                // Kirim notifikasi sistem
                await conn.sendMessage(data.groupId, {
                    text: `📢 *PEMBERITAHUAN SISTEM*\n\nMasa jabatan admin sementara untuk @${jid.split('@')[0]} telah berakhir.\n\n*Waktu Seharusnya :* ${waktuBerakhir}\n\n_Mohon maaf, proses demote sempat tertunda karena sistem sempat tidak aktif. Saat ini status admin telah dicabut._`,
                    mentions: [jid]
                });

                // Hapus data yang sudah selesai diproses
                delete dbJadiAdmin[jid];
                saveJadiAdmin();
            } catch (e) {
                console.log("Gagal demote otomatis: ", e.message);
            }
        } else {
            // Jika belum habis, jalankan timer sisa waktunya
            const remaining = data.endTime - now;
            setTimeout(async () => {
                try {
                    await conn.groupParticipantsUpdate(data.groupId, [jid], 'demote');
                    await conn.sendMessage(data.groupId, {
                        text: `⏰ Waktu admin habis. @${jid.split('@')[0]} telah dicabut akses adminnya.`,
                        mentions: [jid]
                    });
                    delete dbJadiAdmin[jid];
                    saveJadiAdmin();
                } catch (e) {}
            }, remaining);
        }
    }
}

let isSoundPlayed = false;
let enableConnectionSound = false;

/* ------------- START BOT ------------- */
async function startBot() {
    const {
        state,
        saveCreds
    } = await useMultiFileAuthState("session_bot");
    const {
        version
    } = await fetchLatestBaileysVersion();

    const conn = makeWASocket({
        version,
        auth: state,
        logger: pino({
            level: "silent"
        }),
        browser: ["Bot-Ikyy-Pro-2026", "Chrome", "1.0.0"],
    });

    conn.ev.on("creds.update", saveCreds);

    conn.ev.on("group-participants.update", async (anu) => {
        try {
            const time = moment().tz("Asia/Jakarta").format("DD/MM/YYYY HH:mm:ss");
            const pId = typeof anu.participants[0] === 'object' ? anu.participants[0].id : anu.participants[0];
            const pureNumber = pId.split('@')[0];

            if (anu.action === 'add') {
                const isAddedByAdmin = anu.author && anu.author !== pId;
                let method = isAddedByAdmin ? "Dimasukkan Admin" : "Tautan Grup (Link)";
                const welcomeText = `👋 *SELAMAT DATANG*\nNama: @${pureNumber}\nId: ${pureNumber}\nWaktu: ${time}\nMetode: ${method}\n\n🤖 *CARA PENGGUNAAN:*\nKetik *.menu* untuk melihat daftar perintah bot.`;
                await conn.sendMessage(anu.id, {
                    text: welcomeText,
                    mentions: [pId]
                });
            } else if (anu.action === 'remove') {

                if (kickQueue.has(pId)) {
                    kickQueue.delete(pId); // Hapus dari antrean setelah terdeteksi
                    return; // Berhenti di sini, jangan kirim pesan "Telah Keluar..."
                }

                let status = "Keluar";
                const isKicked = anu.author && anu.author !== pId;

                // Ambil nomor murni dari ID partisipan yang keluar
                const pNumber = pId.split('@')[0].split(':')[0];

                // Ambil nomor murni dari ID pelaku (author)
                const authorNumber = anu.author ? anu.author.split('@')[0].split(':')[0] : null;
                const botNumber = conn.user.id.split('@')[0].split(':')[0];

                // Cek apakah ini kick oleh bot
                const isKickedByBot = authorNumber === botNumber;

                // Jika di-kick oleh bot, HENTIKAN (jangan tampilkan pesan apapun)
                if (isKickedByBot) {
                    return;
                }

                // Jika sampai di sini, artinya bukan bot yang melakukan kick
                const isKickedByAdmin = anu.author && anu.author !== pId;
                status = isKickedByAdmin ? "Dikeluarkan Admin" : "Keluar Sendiri";

                const pName = dbNama[pId] || "Member";
                
                // MODIFIKASI DISINI: Menambahkan simbol @ dan teks yang lebih rapi
                const leaveText = `👋 *SAYONARA* \n\n@${pNumber} Telah ${status}\nNama: ${pName}\nWaktu: ${time}`;

                await conn.sendMessage(anu.id, {
                    text: leaveText,
                    mentions: [pId] // INI KUNCINYA: Agar member yang keluar ter-tag
                });
            }

        } catch (err) {
            console.log("Error Event: ", err.message);
        }
    });

    conn.ev.on("connection.update", async (update) => {
        const {
            connection,
            lastDisconnect,
            qr
        } = update;

        if (qr) qrcode.generate(qr, {
            small: true
        });

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect.error instanceof Boom ?
                lastDisconnect.error.output?.statusCode !==
                DisconnectReason.loggedOut :
                true;

            if (shouldReconnect) {
                const waktuPutus = moment().tz("Asia/Jakarta").format("DD/MM/YYYY [Jam] HH:mm");

                console.log(`⚠️ BOT TERPUTUS PADA ${waktuPutus}, MEMULAI RESTART OTOMATIS...`);

                // Gunakan mode background agar tidak memberatkan sistem saat layar mati
                if (enableConnectionSound && !isSoundPlayed) {
                    exec(`ffplay -nodisp -autoexit -af "volume=3" "./off.mp3" > /dev/null 2>&1 &`);
                    isSoundPlayed = true;
                }

                try {
                    await conn.sendMessage(ownerId + "@s.whatsapp.net", {
                        text: `⚠️ *PERINGATAN SISTEM*\n\nBot mengalami gangguan dan sedang melakukan restart otomatis.\n\n📅 *Waktu Kejadian:* ${waktuPutus}`,
                    });
                } catch (e) {}

                startBot();
            }

        } else if (connection === "open") {
            botConnectionOpen = true;

            // Jalankan di background
            if (enableConnectionSound && isSoundPlayed) {
                exec(`ffplay -nodisp -autoexit -af "volume=3" "./on.mp3" > /dev/null 2>&1 &`);
                isSoundPlayed = false;
            }

            console.log("🔄 Menyinkronkan data admin...");
            await checkPendingAdmin(conn);

            if (countdownFinished) {
                console.log("✅ Sinkronisasi Admin Selesai.");
                console.log("✅ BOT AKTIF!");
            }
        }

    });

    conn.ev.on("messages.upsert", async (chat) => {
        const m = chat.messages[0];
        if (!m.message) return;

        const from = m.key.remoteJid;
        const isGroup = from.endsWith("@g.us");

        if (m.key.fromMe) return;

        // Kita tambahkan tanda tanya (?) dan fallback agar tidak error kalau datanya null
        let sender = isGroup ? m.key.participant : m.key.remoteJid;
        let senderId = sender ? sender.split("@")[0].split(":")[0] : "";

        // Baru setelah itu cek owner & banned
        const isOwner = senderId === ownerId;
        const isBanned = dbBanned.includes(senderId) && !isOwner;

        let isAdmin = false;
        if (isGroup) {
            const groupMetadata = await conn.groupMetadata(from);
            isAdmin = groupMetadata.participants.find((p) => p.id.split("@")[0].split(":")[0] === senderId)?.admin !== null;
        }

        if (isGroup && dbAntiSticker[from] && m.message?.stickerMessage && !isAdmin && !isOwner) {
            try {
                await conn.sendMessage(from, {
                    delete: {
                        remoteJid: from,
                        fromMe: false,
                        id: m.key.id,
                        participant: m.key.participant,
                    },
                });
            } catch (e) {}
        }

        const senderName = m.pushName || "Member";
        if (senderId && senderName !== "Member") {
            dbNama[senderId] = senderName;
            fs.writeFileSync("./nama_user.json", JSON.stringify(dbNama));
        }

        const body = m.message.conversation ||
            m.message.extendedTextMessage?.text ||
            m.message.imageMessage?.caption ||
            m.message.videoMessage?.caption || "";
        if (!body.startsWith(".")) return;

        if (isBanned) return;

        const command = body.slice(1).trim().split(/ +/).shift().toLowerCase();
        const args = body.slice(1).trim().split(/ +/).slice(1);

        try {
            switch (command) {
                case 'menu':
                    const menu = `
ㅤㅤ    *╔⏤⏤⏤⏤⏤⏤⏤⏤⏤⏤╗*
*╔⏤⏤╝ 🤖𓂸 ʙᴏᴛ ɪᴋʏʏ 𓂸⚡╚⏤⏤╗*
*│*
*│* 📂 *ᴍᴇɴᴜ(ᴍᴇᴍʙᴇʀ) :*                         𓂺
*│*➤ .s - sᴛɪᴋᴇʀ (ʀᴇᴘʟʏ ᴘɪᴄᴛ/ᴠɪᴅ)
*│*➤ .s <ᴛᴇᴋs> - sᴛɪᴋᴇʀ + ᴛᴇᴋs (ʀᴇᴘʟʏ)
*│*➤ .mʏsᴛ <ɴᴀᴍᴀ> - ᴍᴇɴᴄᴜʀɪ (ʀᴇᴘʟʏ sᴛɪᴋᴇʀ)
*│*➤ .ʜ2 <ᴛᴇᴋs> - ʜɪᴅᴇᴛᴀɢ
*│*➤ .ᴍᴘ3 - ᴠɪᴅ ᴋᴇ ᴍᴘ3 (ʀᴇᴘʟʏ ᴠɪᴅ)
*│*➤ .ʙᴜᴋᴀ - ʙᴜᴋᴀ sᴇᴋᴀʟɪ ʟɪʜᴀᴛ (ʀᴇᴘʟʏ ᴘᴇsᴀɴ)
*│*➤ .ᴅᴇʟ - ʜᴀᴘᴜs ᴘᴇsᴀɴ (ʀᴇᴘʟʏ ᴘᴇsᴀɴ)
*│*➤ .ᴄᴇᴋ - ᴄᴇᴋ sᴀʟᴅᴏ & ʟɪᴍɪᴛ
*│*➤ .ᴄʟᴀɪᴍ - ᴋʟᴀɪᴍ ʜᴀᴅɪᴀʜ ʜᴀʀɪᴀɴ (10k)
*│*➤ .sʟᴏᴛ <ɴᴏᴍɪɴᴀʟ> - ᴍᴀɪɴ sʟᴏᴛ ʜᴀʟᴀʟ
*│*
*│*
*│* 🛡 *ᴍᴇɴᴜ(ᴀᴅᴍɪɴ) :*                   ˙ᵕ˙
*│*➤ .ᴀɴᴛɪsᴛɪᴄᴋᴇʀ <ᴏɴ/ᴏғғ>
*│*➤ .ᴊᴀᴅɪᴀᴅᴍɪɴ @ᴛᴀɢ <ᴡᴀᴋᴛᴜ>
*│*➤ .ᴋɪᴄᴋ @ᴛᴀɢ/ʀᴇᴘʟʏ - ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀ
*│*                          *𓃮*
*│*
*│  -ˋˏ✄┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈*
*│*
*│* 👑 *ᴏᴡɴᴇʀ :*                                ➳ *𓀐*╲
*│* .ʙᴀɴ @ᴛᴀɢ | .ᴜɴʙᴀɴ @ᴛᴀɢ
*│* .ᴀᴅᴅᴍᴏɴᴇʏ @ᴛᴀɢ | .ᴅᴇʟᴍᴏɴᴇʏ @ᴛᴀɢ
*│* .ᴀᴅᴅʟɪᴍɪᴛ @ᴛᴀɢ | .ᴅᴇʟʟɪᴍɪᴛ @ᴛᴀɢ
*│*                                             ツ
*│* ⚙️ sʏsᴛᴇᴍ :
*│* .ɪɴғᴏ | .ᴍᴏᴅᴇ | .ᴏᴡɴᴇʀ
*│*
*│*           ⛟                                        ᵇᵉᵗᵃ
*╚⏤⏤⏤⏤⏤⏤╗ 𓆈 ╔⏤⏤⏤⏤⏤⏤╝*
ㅤㅤㅤㅤㅤㅤ      *╚⏤⏤╝*`;

                    await conn.sendMessage(from, {
                        text: menu
                    }, {
                        quoted: m
                    });
                    break;

                case 'myst':
                    const qSticker = m.message.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage;
                    if (!qSticker) return conn.sendMessage(from, {
                        text: "Reply stiker dengan caption .myst <nama>"
                    }, {
                        quoted: m
                    });
                    const pack = args.length > 0 ? args.join(" ") : "stiker";
                    const streamSticker = await downloadContentFromMessage(qSticker, 'sticker');
                    let bufSticker = Buffer.from([]);
                    for await (const chunk of streamSticker) bufSticker = Buffer.concat([bufSticker, chunk]);
                    const fixed = await editExif(bufSticker, pack, "bot ikyy");
                    await conn.sendMessage(from, {
                        sticker: fixed
                    }, {
                        quoted: m
                    });
                    break;

                case 'ban':
                    if (!isOwner) return conn.sendMessage(from, {
                        text: "❌ Fitur khusus Owner!"
                    }, {
                        quoted: m
                    });
                    const targetB = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0];
                    if (!targetB) return conn.sendMessage(from, {
                        text: "Contoh: .ban @tag"
                    }, {
                        quoted: m
                    });
                    const numB = targetB.replace(/[^0-9]/g, '');
                    if (numB === ownerId) return conn.sendMessage(from, {
                        text: "❌ Tidak bisa ban Owner!"
                    }, {
                        quoted: m
                    });
                    if (dbBanned.includes(numB)) return conn.sendMessage(from, {
                        text: "❌ User sudah terdaftar di daftar banned."
                    }, {
                        quoted: m
                    });
                    dbBanned.push(numB);
                    saveBanned();
                    await conn.sendMessage(from, {
                        text: `✅ Berhasil membanned: ${numB}`
                    }, {
                        quoted: m
                    });
                    break;

                case 'unban':
                    if (!isOwner) return conn.sendMessage(from, {
                        text: "❌ Fitur khusus Owner!"
                    }, {
                        quoted: m
                    });
                    const targetU = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || args[0];
                    if (!targetU) return conn.sendMessage(from, {
                        text: "Contoh: .unban @tag"
                    }, {
                        quoted: m
                    });
                    const numU = targetU.replace(/[^0-9]/g, '');
                    const index = dbBanned.indexOf(numU);
                    if (index === -1) return conn.sendMessage(from, {
                        text: "❌ Nomor tidak ada dalam daftar banned."
                    }, {
                        quoted: m
                    });
                    dbBanned.splice(index, 1);
                    saveBanned();
                    await conn.sendMessage(from, {
                        text: `✅ Berhasil mengunban: ${numU}`
                    }, {
                        quoted: m
                    });
                    break;

                case 'jadiadmin':
                    if (!isGroup) return conn.sendMessage(from, {
                        text: "Fitur ini hanya untuk grup!"
                    }, {
                        quoted: m
                    });
                    if (!isAdmin && !isOwner) return conn.sendMessage(from, {
                        text: "❌ Hanya Admin atau Owner!"
                    }, {
                        quoted: m
                    });

                    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid;
                    const timeInput = args.slice(1).join(" ").toLowerCase();

                    if (!mentioned || mentioned.length === 0 || !timeInput) {
                        return conn.sendMessage(from, {
                            text: "Format salah! Gunakan: .jadiadmin @tag 1hari 2j 30mnt"
                        }, {
                            quoted: m
                        });
                    }

                    const targetAdmin = mentioned[0];

                    // Proteksi: Cek apakah target sudah admin asli
                    const metaDataGrup = await conn.groupMetadata(from);
                    const targetParticipant = metaDataGrup.participants.find(p => p.id === targetAdmin);
                    if (targetParticipant?.admin) return conn.sendMessage(from, {
                        text: "❌ Target sudah menjadi Admin, tidak perlu dijadikan admin kembali."
                    }, {
                        quoted: m
                    });

                    if (dbJadiAdmin[targetAdmin]) return conn.sendMessage(from, {
                        text: "❌ Target sudah dalam masa admin aktif!"
                    }, {
                        quoted: m
                    });

                    let totalMs = 0;
                    let desc = [];
                    const hariMatch = timeInput.match(/(\d+)\s*(hari|hr|d|day)/i);
                    const jamMatch = timeInput.match(/(\d+)\s*(jam|j|jm|h|hour|hours)/i);
                    const mntMatch = timeInput.match(/(\d+)\s*(menit|mnt|m|min|minute|minutes)/i);

                    if (hariMatch) {
                        totalMs += parseInt(hariMatch[1]) * 86400000;
                        desc.push(`${hariMatch[1]} Hari`);
                    }
                    if (jamMatch) {
                        totalMs += parseInt(jamMatch[1]) * 3600000;
                        desc.push(`${jamMatch[1]} Jam`);
                    }
                    if (mntMatch) {
                        totalMs += parseInt(mntMatch[1]) * 60000;
                        desc.push(`${mntMatch[1]} Menit`);
                    }

                    if (totalMs === 0) return conn.sendMessage(from, {
                        text: "Format waktu salah! Gunakan contoh: 1h 2j 30m"
                    }, {
                        quoted: m
                    });

                    try {
                        await conn.groupParticipantsUpdate(from, [targetAdmin], 'promote');

                        // Simpan data
                        dbJadiAdmin[targetAdmin] = {
                            groupId: from,
                            endTime: Date.now() + totalMs
                        };
                        saveJadiAdmin();

                        await conn.sendMessage(from, {
                            text: `✅ Berhasil! @${targetAdmin.split('@')[0]} dijadikan admin sementara selama ${desc.join(', ')}.`,
                            mentions: [targetAdmin]
                        }, {
                            quoted: m
                        });

                        // Timeout untuk eksekusi saat bot online
                        setTimeout(async () => {
                            if (dbJadiAdmin[targetAdmin]) {
                                try {
                                    // Coba demote
                                    await conn.groupParticipantsUpdate(from, [targetAdmin], 'demote');

                                    // JIKA BERHASIL BARU HAPUS
                                    delete dbJadiAdmin[targetAdmin];
                                    saveJadiAdmin();

                                    const waktuBerakhir = moment().tz("Asia/Jakarta").format("dddd, DD/MM/YYYY HH:mm:ss");
                                    await conn.sendMessage(from, {
                                        text: `📢 *PEMBERITAHUAN SISTEM*\n\nMasa jabatan admin sementara untuk @${targetAdmin.split('@')[0]} telah berakhir.\n\n*Pada :* ${waktuBerakhir}\n\n_Sistem telah melakukan demote secara otomatis._`,
                                        mentions: [targetAdmin]
                                    });
                                } catch (e) {
                                    console.log("Gagal demote otomatis, data tetap tersimpan untuk dicoba ulang oleh sistem saat bot reconnect.");
                                }
                            }
                        }, totalMs);
                    } catch (e) {
                        await conn.sendMessage(from, {
                            text: "Gagal memberikan akses admin. Pastikan bot memiliki akses Admin di grup."
                        }, {
                            quoted: m
                        });
                    }
                    break;


                case 'antisticker':
                    if (!isGroup) return conn.sendMessage(from, {
                        text: "Fitur ini hanya untuk grup!"
                    }, {
                        quoted: m
                    });
                    if (!isAdmin && !isOwner) return conn.sendMessage(from, {
                        text: "❌ Hanya Admin atau Owner!"
                    }, {
                        quoted: m
                    });
                    const action = args[0]?.toLowerCase();
                    if (action === 'on') {
                        dbAntiSticker[from] = true;
                        saveAnti();
                        await conn.sendMessage(from, {
                            text: "✅ AntiSticker telah diaktifkan!"
                        }, {
                            quoted: m
                        });
                    } else if (action === 'off') {
                        dbAntiSticker[from] = false;
                        saveAnti();
                        await conn.sendMessage(from, {
                            text: "❌ AntiSticker telah dinonaktifkan!"
                        }, {
                            quoted: m
                        });
                    }
                    break;

                case 'h2':
                    if (!isGroup) return conn.sendMessage(from, {
                        text: "Fitur ini hanya untuk grup!"
                    }, {
                        quoted: m
                    });
                    if (!isAdmin && !isOwner) return conn.sendMessage(from, {
                        text: "❌ Hanya Admin atau Owner!"
                    }, {
                        quoted: m
                    });
                    const groupMeta = await conn.groupMetadata(from);
                    const users = getParticipantJids(groupMeta.participants || []);
                    const fakeQuoted = {
                        key: {
                            fromMe: false,
                            participant: '0@s.whatsapp.net',
                            remoteJid: 'status@broadcast'
                        },
                        message: {
                            conversation: 'Bot Ikyy'
                        }
                    };
                    const textH2 = args.join(" ");
                    if (!textH2) return conn.sendMessage(from, {
                        text: "Contoh: .h2 Pesan untuk semua member!"
                    }, {
                        quoted: m
                    });
                    await conn.sendMessage(from, {
                        text: textH2,
                        mentions: users
                    }, {
                        quoted: fakeQuoted
                    });
                    break;

                case 'mode':
                    let role = isOwner ? "Owner 👑" : (isAdmin ? "Admin 🛡️" : "MEMBER 👥");
                    await conn.sendMessage(from, {
                        text: `🤖 *BOT STATUS: ACTIVE*\nUser: ${role}\nID: ${senderId}`
                    }, {
                        quoted: m
                    });
                    break;

                case "info":
                    const p = require("./package.json");

                    const duration = moment.duration(Date.now() - startTime);
                    const uptime = `${duration.hours()} jam ${duration.minutes()} menit`;

                    const botNum = conn.user.id.split(":")[0];

                    await conn.sendMessage(
                        from, {
                            text: `*BOT INFO*\nVersi: ${p.version}\nRuntime: ${uptime}\nBot Number: ${botNum}`,
                        }, {
                            quoted: m
                        }
                    );
                    break;

                case "owner":
                    await conn.sendMessage(
                        from, {
                            text: `
      👤 *CONTACT OWNER*
    *ID Owner:* ${ownerId}
    *Nomor HP:* +62 856-0320-9755
    *WhatsApp:* wa.me/6285603209755

_Silahkan hubungi nomor di atas jika ada keperluan mendesak atau pertanyaan mengenai bot._`,
                        }, {
                            quoted: m
                        }
                    );
                    break;

                case 's': {
                    // Ambil quoted jika ada
                    const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;

                    // Logika: Cek apakah pesan itu sendiri adalah media, atau me-reply media
                    const mediaMsg = m.message.imageMessage || m.message.videoMessage ||
                        quoted?.imageMessage || quoted?.videoMessage;

                    if (!mediaMsg) return conn.sendMessage(from, {
                        text: "Kirim foto/video dengan caption *.s* atau reply media dengan *.s*!"
                    }, {
                        quoted: m
                    });

                    // Tentukan tipe (image/video)
                    const type = (mediaMsg.mimetype?.includes("video") || quoted?.videoMessage || m.message?.videoMessage) ? "video" : "image";

                    // Cek ukuran file
                    const fileSize = mediaMsg.fileLength || 0;
                    if (fileSize > 10 * 1024 * 1024) return conn.sendMessage(from, {
                        text: "❌ Maksimal 10MB!"
                    }, {
                        quoted: m
                    });

                    await conn.sendMessage(from, {
                        text: "⏳ Sedang diproses..."
                    }, {
                        quoted: m
                    });

                    const textSticker = args.join(" ");

                    // 2. SANITASI TEKS - Mencegah error FFmpeg akibat karakter khusus (: \ ' %)
                    // Kita hapus karakter yang bisa memutus command FFmpeg
                    const cleanText = textSticker.replace(/[:\\'%]/g, '').replace(/'/g, "\\'");

                    try {
                        // mediaMsg sudah berisi objek murni (imageMessage/videoMessage)
                        const stream = await downloadContentFromMessage(mediaMsg, type);

                        let buf = Buffer.from([]);
                        for await (const chunk of stream) {
                            buf = Buffer.concat([buf, chunk]);
                        }

                        const id = crypto.randomBytes(6).toString("hex");
                        const tmpInput = `./tmp_${id}.${type === "image" ? "jpg" : "mp4"}`;
                        const tmpOutput = `./tmp_${id}.webp`;

                        fs.writeFileSync(tmpInput, buf);

                        // 3. OPTIMASI FFMPEG - Durasi, Kompresi, dan FPS
                        // -t 5: Potong video jadi 5 detik (Limit maksimal WA agar tidak rusak/statis)
                        // fps=15: Mengurangi jumlah frame agar ukuran file tetap ringan
                        // -fs 950K: Memastikan file WebP tidak lebih dari 1MB (Limit mutlak WhatsApp)
                        // -pix_fmt yuv420p: Agar kompatibel di Android & iOS
                        // -qscale 15: Mengatur kualitas agar tetap jernih tapi ukuran kecil
                        const videoOptions = "-loop 0 -t 5 -preset default -an -vsync 0 -pix_fmt yuv420p -qscale 15 -fs 950K";
                        const imageOptions = "-lossless 1";

                        const filterDrawText = cleanText ?
                            `,drawtext=text='${cleanText}':fontcolor=white:fontsize=40:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-text_h-30` :
                            "";

                        exec(
                            `ffmpeg -i ${tmpInput} -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:x=(ow-iw)/2:y=(oh-ih)/2,fps=15${filterDrawText}" -vcodec libwebp ${
                                type === "video" ? videoOptions : imageOptions
                            } ${tmpOutput}`,
                            async (err) => {
                                if (err) {
                                    console.error("FFmpeg Error:", err);
                                    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
                                    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
                                    return conn.sendMessage(from, {
                                        text: "❌ Gagal mengonversi stiker. Pastikan media tidak rusak."
                                    }, {
                                        quoted: m
                                    });
                                }

                                const finalSticker = fs.readFileSync(tmpOutput);

                                // Verifikasi akhir ukuran file sebelum kirim
                                if (finalSticker.length > 0 && finalSticker.length < 1024 * 1024) {
                                    await conn.sendMessage(
                                        from, {
                                            sticker: await editExif(
                                                finalSticker,

                                                /* ---- NAMA STIKER --- */
                                                "Powered by @kkykrnwn",

                                                /* --- NAMA STIKERPACK --- */
                                                "Bot Ikyy"
                                            ),
                                        }, {
                                            quoted: m
                                        }
                                    );
                                } else if (finalSticker.length >= 1024 * 1024) {
                                    await conn.sendMessage(from, {
                                        text: "⚠️ Hasil stiker terlalu berat (>1MB). Coba gunakan video dengan durasi lebih singkat."
                                    }, {
                                        quoted: m
                                    });
                                }

                                // Hapus file temporary agar memori tidak penuh
                                if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
                                if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
                            }
                        );
                    } catch (e) {
                        console.error("System Error:", e);
                        conn.sendMessage(from, {
                            text: "❌ Terjadi kesalahan pada sistem saat mengunduh media."
                        }, {
                            quoted: m
                        });
                        // Cleanup jika terjadi error di tengah jalan
                        const files = fs.readdirSync('./').filter(file => file.startsWith('tmp_'));
                        files.forEach(file => fs.unlinkSync(file));
                    }
                }
                break;

                case 'mp3':
                    const qMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!qMsg?.videoMessage) return conn.sendMessage(from, {
                        text: "Reply video!"
                    }, {
                        quoted: m
                    });
                    const idM = crypto.randomBytes(6).toString('hex');
                    const vInput = `./tmp_${idM}.mp4`,
                        aOutput = `./tmp_${idM}.mp3`;
                    fs.writeFileSync(vInput, await (async () => {
                        let b = Buffer.from([]);
                        for await (const c of await downloadContentFromMessage(qMsg.videoMessage, 'video')) b = Buffer.concat([b, c]);
                        return b;
                    })());
                    exec(`ffmpeg -i ${vInput} -vn -ar 44100 -ac 2 -b:a 128k ${aOutput}`, async (err) => {
                        if (!err) await conn.sendMessage(from, {
                            audio: fs.readFileSync(aOutput),
                            mimetype: 'audio/mp4',
                            ptt: false
                        }, {
                            quoted: m
                        });
                        [vInput, aOutput].forEach(f => {
                            if (fs.existsSync(f)) fs.unlinkSync(f);
                        });
                    });
                    break;

                case "buka":
                    const q = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!q) return conn.sendMessage(from, {
                        text: "Reply pesan Sekali Lihat!"
                    }, {
                        quoted: m
                    });

                    const isViewOnce = q.viewOnceMessage ||
                        q.viewOnceMessageV2 ||
                        q.viewOnceMessageV2Extension ||
                        (q.imageMessage && q.imageMessage.viewOnce === true) ||
                        (q.videoMessage && q.videoMessage.viewOnce === true);

                    if (!isViewOnce) {
                        return conn.sendMessage(from, {
                            text: "❌ Pesan ini tidak memiliki flag 'Sekali Lihat'.",
                            quoted: m
                        });
                    }

                    const msgContent = q.viewOnceMessage?.message ||
                        q.viewOnceMessageV2?.message ||
                        q.viewOnceMessageV2Extension?.message ||
                        q;

                    const tipeMedia = getContentType(msgContent);
                    const mediaData = msgContent[tipeMedia];

                    const captionMedia = mediaData.caption || "";

                    await conn.sendMessage(from, {
                        text: "⏳ Sedang memproses media..."
                    }, {
                        quoted: m
                    });

                    try {
                        const stream = await downloadContentFromMessage(mediaData, tipeMedia.replace('Message', ''));
                        let buffer = Buffer.from([]);
                        for await (const chunk of stream) {
                            buffer = Buffer.concat([buffer, chunk]);
                        }

                        let teksBalasan = "✅ *Media Berhasil Diekstraksi*";
                        if (captionMedia) {
                            teksBalasan += `\n\n*Caption:* ${captionMedia}`;
                        } else {
                            teksBalasan += `\n\n_Informasi: Tidak ada keterangan (caption) pada media ini._`;
                        }

                        await conn.sendMessage(from, {
                            [tipeMedia.replace('Message', '')]: buffer,
                            caption: teksBalasan
                        }, {
                            quoted: m
                        });
                    } catch (e) {
                        console.error(e);
                        await conn.sendMessage(from, {
                            text: "❌ Terjadi kesalahan sistem saat memproses media!"
                        }, {
                            quoted: m
                        });
                    }
                    break;

                case 'del':
                    const qDel = m.message.extendedTextMessage?.contextInfo;
                    if (!qDel) return conn.sendMessage(from, {
                        text: "Reply pesan!"
                    }, {
                        quoted: m
                    });
                    try {
                        await conn.sendMessage(from, {
                            delete: {
                                remoteJid: from,
                                fromMe: qDel.participant === conn.user.id,
                                id: qDel.stanzaId,
                                participant: qDel.participant
                            }
                        });
                    } catch (e) {}
                    break;

                case "slot": {
                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    const saveDbSlot = () => fs.writeFileSync("./slot.json", JSON.stringify(dbSlot, null, 2));

                    if (!dbSlot[senderId]) dbSlot[senderId] = {
                        limit: 10,
                        money: 0
                    };
                    const user = dbSlot[senderId];

                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

                    if ((user.limit || 0) < 1) return conn.sendMessage(from, {
                        text: `❌ Batas penggunaan (limit) telah habis.\nGunakan perintah .claim untuk mendapatkan tambahan kuota harian sebesar 30 limit.`
                    }, {
                        quoted: m
                    });

                    const nominalRaw = args[0] ? args[0].replace(/\./g, '') : "0";
                    const nominal = parseInt(nominalRaw);

                    if (isNaN(nominal) || nominal < 500) {
                        return conn.sendMessage(from, {
                            text: `🎰 *VIRTUAL SLOT*\n\n❌ Taruhan minimal adalah *500 perak*!\nGunakan: *.slot [nominal]*\nContoh: *.slot 5.000*`
                        }, {
                            quoted: m
                        });
                    }

                    if (user.money < nominal) return conn.sendMessage(from, {
                        text: `❌ *Transaksi Gagal: Saldo Tidak Mencukupi*\n\n` +
                            `Saldo Anda saat ini: *${formatRibuan(user.money)}*\n\n` +
                            `_Catatan: Silakan gunakan perintah *.claim* untuk mendapatkan tunjangan dana harian sebesar 50.000._`
                    }, {
                        quoted: m
                    });

                    // --- LOGIKA WIN RATE (SETINGAN) ---
                    const winRate = isOwner ? 0.8 : 0.5; // Owner 80%, Member 50%
                    const isWinningTurn = Math.random() < winRate;

                    const symbols = ['🍇', '🍉', '🍋', '🍌', '🍎', '🍑', '🍒', '🫐', '🥥', '🥑'];
                    const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

                    let spin;
                    if (isWinningTurn) {
                        // Jika menang, kita paksa baris tengah (index 3,4,5) jadi sama
                        const winSymbol = pickRandom(symbols);
                        spin = [
                            pickRandom(symbols), pickRandom(symbols), pickRandom(symbols), // Baris 1 (Acak)
                            winSymbol, winSymbol, winSymbol, // Baris 2 (MENANG)
                            pickRandom(symbols), pickRandom(symbols), pickRandom(symbols) // Baris 3 (Acak)
                        ];
                    } else {
                        // Jika kalah, kita acak murni (kemungkinan menang alami sangat kecil)
                        spin = Array.from({
                            length: 9
                        }, () => pickRandom(symbols));
                    }

                    const row1 = `${spin[0]} : ${spin[1]} : ${spin[2]}`;
                    const row2 = `${spin[3]} : ${spin[4]} : ${spin[5]}`;
                    const row3 = `${spin[6]} : ${spin[7]} : ${spin[8]}`;

                    user.limit -= 1;
                    user.money -= nominal;

                    let ket = 'You Lose 📉';
                    let hadiahUang = 0;
                    let hadiahLimit = 0;

                    // Cek Kemenangan
                    const midSame = spin[3] === spin[4] && spin[4] === spin[5];
                    const allSame = spin.every(v => v === spin[0]);

                    if (allSame) {
                        ket = 'JACKPOT BESAR 🎉💰';
                        hadiahUang = nominal * 10;
                        hadiahLimit = 10;
                    } else if (midSame) {
                        ket = 'JACKPOT 🎉';
                        hadiahUang = nominal * 5;
                        hadiahLimit = 5;
                    }

                    if (hadiahUang > 0) user.money += hadiahUang;
                    if (hadiahLimit > 0) user.limit += hadiahLimit;
                    saveDbSlot();

                    const hasilPesan = `
[  🎰 *VIRTUAL SLOT* 🎰  ]
--------------------------
${row1}
${row2}  <=====
${row3}
--------------------------
*INFO BERMAIN* :
Status : ${ket}
${hadiahUang > 0 ? `💰 Hadiah: +${formatRibuan(hadiahUang)}\n🎫 Limit: +${hadiahLimit}` : `💸 Kalah: -${formatRibuan(nominal)}\n🎫 Limit: -1`}

*SALDO AKHIR* :
💰 Money: ${formatRibuan(user.money)}
🎫 Limit: ${user.limit}`;

                    await conn.sendMessage(from, {
                        text: hasilPesan
                    }, {
                        quoted: m
                    });
                }
                break;

                case 'addmoney': {
                    if (!isOwner) return conn.sendMessage(from, {
                        text: "❌ Fitur ini khusus Owner!"
                    }, {
                        quoted: m
                    });
                    let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net" : null);

                    // PERBAIKAN: Menghapus titik dari input user agar 20.000 terbaca 20000
                    let nominalRaw = args[1] ? args[1].replace(/\./g, '') : "0";
                    let nominal = parseInt(nominalRaw);

                    if (!target || isNaN(nominal)) return conn.sendMessage(from, {
                        text: "Contoh: .addmoney @tag 20.000"
                    }, {
                        quoted: m
                    });

                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    let tId = target.split("@")[0].split(":")[0];
                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

                    if (!dbSlot[tId]) dbSlot[tId] = {
                        limit: 10,
                        money: 0
                    };
                    dbSlot[tId].money += nominal;
                    fs.writeFileSync("./slot.json", JSON.stringify(dbSlot, null, 2));

                    let teks = `✅ *SALDO BERHASIL DITAMBAHKAN*\n\n👤 User: @${tId}\n➕ Nominal: +${formatRibuan(nominal)}\n──────────────────\n💰 *Total Saldo:* ${formatRibuan(dbSlot[tId].money)}\n🎫 *Total Limit:* ${dbSlot[tId].limit}`;
                    await conn.sendMessage(from, {
                        text: teks,
                        mentions: [target]
                    }, {
                        quoted: m
                    });
                }
                break;

                case 'delmoney': {
                    if (!isOwner) return conn.sendMessage(from, {
                        text: "❌ Fitur ini khusus Owner!"
                    }, {
                        quoted: m
                    });
                    let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net" : null);

                    // PERBAIKAN: Menghapus titik dari input user
                    let nominalRaw = args[1] ? args[1].replace(/\./g, '') : "0";
                    let nominal = parseInt(nominalRaw);

                    if (!target || isNaN(nominal)) return conn.sendMessage(from, {
                        text: "Contoh: .delmoney @tag 20.000"
                    }, {
                        quoted: m
                    });

                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    let tId = target.split("@")[0].split(":")[0];
                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

                    if (!dbSlot[tId]) dbSlot[tId] = {
                        limit: 10,
                        money: 0
                    };
                    dbSlot[tId].money = Math.max(0, dbSlot[tId].money - nominal);
                    fs.writeFileSync("./slot.json", JSON.stringify(dbSlot, null, 2));

                    let teks = `📉 *SALDO BERHASIL DIKURANGI*\n\n👤 User: @${tId}\n➖ Nominal: -${formatRibuan(nominal)}\n──────────────────\n💰 *Total Saldo:* ${formatRibuan(dbSlot[tId].money)}\n🎫 *Total Limit:* ${dbSlot[tId].limit}`;
                    await conn.sendMessage(from, {
                        text: teks,
                        mentions: [target]
                    }, {
                        quoted: m
                    });
                }
                break;

                case 'addlimit': {
                    if (!isOwner) return conn.sendMessage(from, {
                        text: "❌ Fitur ini khusus Owner!"
                    }, {
                        quoted: m
                    });
                    let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net" : null);
                    let nominal = parseInt(args[1]);
                    if (!target || isNaN(nominal)) return conn.sendMessage(from, {
                        text: "Contoh: .addlimit @tag 10"
                    }, {
                        quoted: m
                    });
                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    let tId = target.split("@")[0].split(":")[0];
                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
                    if (!dbSlot[tId]) dbSlot[tId] = {
                        limit: 10,
                        money: 0
                    };
                    dbSlot[tId].limit += nominal;
                    fs.writeFileSync("./slot.json", JSON.stringify(dbSlot, null, 2));
                    let teks = `✅ *LIMIT BERHASIL DITAMBAHKAN*\n\n👤 User: @${tId}\n➕ Nominal: +${nominal}\n──────────────────\n🎫 *Total Limit:* ${dbSlot[tId].limit}\n💰 *Total Saldo:* ${formatRibuan(dbSlot[tId].money)}`;
                    await conn.sendMessage(from, {
                        text: teks,
                        mentions: [target]
                    }, {
                        quoted: m
                    });
                }
                break;

                case 'dellimit': {
                    if (!isOwner) return conn.sendMessage(from, {
                        text: "❌ Fitur ini khusus Owner!"
                    }, {
                        quoted: m
                    });
                    let target = m.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || (args[0] ? args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net" : null);
                    let nominal = parseInt(args[1]);
                    if (!target || isNaN(nominal)) return conn.sendMessage(from, {
                        text: "Contoh: .dellimit @tag 5"
                    }, {
                        quoted: m
                    });
                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    let tId = target.split("@")[0].split(":")[0];
                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
                    if (!dbSlot[tId]) dbSlot[tId] = {
                        limit: 10,
                        money: 0
                    };
                    dbSlot[tId].limit = Math.max(0, dbSlot[tId].limit - nominal);
                    fs.writeFileSync("./slot.json", JSON.stringify(dbSlot, null, 2));
                    let teks = `📉 *LIMIT BERHASIL DIKURANGI*\n\n👤 User: @${tId}\n➖ Nominal: -${nominal}\n──────────────────\n🎫 *Total Limit:* ${dbSlot[tId].limit}\n💰 *Total Saldo:* ${formatRibuan(dbSlot[tId].money)}`;
                    await conn.sendMessage(from, {
                        text: teks,
                        mentions: [target]
                    }, {
                        quoted: m
                    });
                }
                break;

                case 'claim': {
                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    if (!dbSlot[senderId]) dbSlot[senderId] = {
                        limit: 10,
                        money: 0,
                        lastClaim: 0
                    };
                    let user = dbSlot[senderId];

                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
                    const rewardMoney = 50000,
                        rewardLimit = 30,
                        cooldown = 86400000;
                    const now = Date.now();

                    if (now - (user.lastClaim || 0) < cooldown) {
                        const duration = moment.duration(cooldown - (now - user.lastClaim)).format("H [jam], m [menit]");
                        return conn.sendMessage(from, {
                            text: `❌ *ANDA SUDAH KLAIM HARI INI*\n\nSilahkan tunggu *${duration}* lagi untuk mengambil hadiah harian berikutnya.`
                        }, {
                            quoted: m
                        });
                    }

                    user.money += rewardMoney;
                    user.limit = (user.limit || 0) + rewardLimit;
                    user.lastClaim = now;
                    fs.writeFileSync("./slot.json", JSON.stringify(dbSlot, null, 2));

                    await conn.sendMessage(from, {
                        text: `🎁 *HADIAH HARIAN BERHASIL*\n\nSelamat @${senderId}, kamu mendapatkan:\n💰 +${formatRibuan(rewardMoney)} Money\n🎫 +${rewardLimit} Limit\n\n──────────────────\n💰 *Total Saldo:* ${formatRibuan(user.money)}\n🎫 *Total Limit:* ${user.limit}`,
                        mentions: [senderId + "@s.whatsapp.net"]
                    }, {
                        quoted: m
                    });
                }
                break;

                case 'cek': {
                    let dbSlot = fs.existsSync("./slot.json") ? JSON.parse(fs.readFileSync("./slot.json", "utf8")) : {};
                    let user = dbSlot[senderId] || {
                        limit: 10,
                        money: 0
                    };
                    const formatRibuan = (x) => x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
                    let teksCek = `📊 *USER STATUS*\n\n👤 User: @${senderId}\n🎫 Limit: ${user.limit}\n💰 Saldo: ${formatRibuan(user.money)}\n\n_Gunakan .slot <nominal> untuk bermain!_`;
                    await conn.sendMessage(from, {
                        text: teksCek,
                        mentions: [senderId + "@s.whatsapp.net"]
                    }, {
                        quoted: m
                    });
                }
                break;

case 'kick':
    if (!isGroup) return conn.sendMessage(from, { text: "Fitur ini hanya untuk grup!" }, { quoted: m });
    if (!isAdmin && !isOwner) return conn.sendMessage(from, { text: "❌ Hanya Admin atau Owner!" }, { quoted: m });

    // 1. Ambil ID dari Reply pesan
    const quotedUpper = m.message.extendedTextMessage?.contextInfo?.participant;
    
    // 2. Ambil ID dari Tag (@mention)
    const mentionedUpper = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    
    // 3. Ambil ID dari ketik nomor langsung (misal: .kick 628xxx)
    let targetKick = [];
    if (quotedUpper) {
        targetKick.push(quotedUpper);
    } else if (mentionedUpper.length > 0) {
        targetKick = mentionedUpper;
    } else if (args[0]) {
        let nomorMurni = args[0].replace(/[^0-9]/g, '') + "@s.whatsapp.net";
        targetKick.push(nomorMurni);
    }

    if (targetKick.length === 0) return conn.sendMessage(from, { text: "Tag, reply, atau masukkan nomornya!" }, { quoted: m });

    // Proteksi: Jangan kick owner atau bot sendiri
    if (targetKick.includes(ownerId + "@s.whatsapp.net") || targetKick.includes(conn.user.id.split(':')[0] + "@s.whatsapp.net")) {
        return conn.sendMessage(from, { text: "❌ Tidak bisa mengeluarkan Owner atau Bot!" }, { quoted: m });
    }

    try {
        await conn.groupParticipantsUpdate(from, targetKick, 'remove');
        await conn.sendMessage(from, { text: `✅ Berhasil mengeluarkan ${targetKick.length} member.` }, { quoted: m });
    } catch (e) {
        console.log(e);
        await conn.sendMessage(from, { text: "Gagal kick member. Pastikan bot adalah Admin dan member tersebut masih di grup!" }, { quoted: m });
    }
    break;

                default:
                    // Peringatan jika perintah tidak ditemukan (Typo)
                    await conn.sendMessage(from, {
                        text: `⚠️ *Perintah tidak ditemukan!* \nKetik *.menu* untuk melihat daftar perintah yang tersedia.`
                    }, {
                        quoted: m
                    });
                    break;
            }
        } catch (err) {
            console.error(err);
        }
    });
}

process.on("uncaughtException", (err) => {
    console.error("❌ CRITICAL ERROR:", err);
});

async function editExif(webpBuffer, packname, author) {
    const img = new Image();

    const json = {
        "sticker-pack-id": "https://github.com/DikaArdnt/Hisoka-Morou",
        "sticker-pack-name": packname,
        "sticker-pack-publisher": author,
        emojis: [""],
    };

    let exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);

    let jsonBuffer = Buffer.from(JSON.stringify(json), "utf8");

    let exif = Buffer.concat([exifAttr, jsonBuffer]);

    exif.writeUIntLE(jsonBuffer.length, 14, 4);

    await img.load(webpBuffer);

    img.exif = exif;

    return await img.save(null);
}

async function countdown() {
    for (let i = 5; i > 0; i--) {
        // Gunakan process.stdout.write agar teks tidak memenuhi layar (opsional) atau tetap console.log
        console.log(`🚀 BOT STARTING IN ${i}...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    countdownFinished = true;
}

async function bootSystem() {
    exec(`ffplay -nodisp -autoexit -af "volume=3" "./start.mp3" > /dev/null 2>&1 &`);

    console.log("╔══════════════════════════════════════════╗");
    console.log("║ 🌐 [GATEWAY-X] VIRTUAL BRIDGE ACTIVE     ║");
    console.log("║ 📊 STATUS: TUNNELED | POLLING: 5000ms    ║");
    console.log("╚══════════════════════════════════════════╝");

    await countdown();
    await startBot();
}

// 1. Jalankan sistem booting-nya
bootSystem();

// 2. Pasang pendengar input terminal (siaga 24 jam)
process.stdin.on("data", (data) => {
    const input = data.toString().trim().toLowerCase();

    if (input === "off") {
        console.log("🛑 Mematikan bot via Terminal...");
        process.exit();
    } else if (input === "status") {
        console.log("──────────────────────────────────────────");
        console.log("📊 [SYSTEM CHECK]");
        console.log(`📡 Status: Online`);
        console.log(`💾 RAM: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
        console.log("──────────────────────────────────────────");
    } else if (input === "clear") {
        console.clear();
        // Setelah clear, tampilkan lagi bannernya biar gak kosong banget
        console.log("╔══════════════════════════════════════════╗");
        console.log("║ 🌐 [GATEWAY-X] VIRTUAL BRIDGE ACTIVE     ║");
        console.log("╚══════════════════════════════════════════╝");
    } else if (input === "sound on") { // <--- TAMBAHKAN INI
        enableConnectionSound = true;
        console.log("🔊 Suara koneksi (on/off) kini: AKTIF");
    } else if (input === "sound off") { // <--- TAMBAHKAN INI
        enableConnectionSound = false;
        console.log("🔇 Suara koneksi (on/off) kini: MATI");
    }

});