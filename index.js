const http = require('http');
const fs = require('fs');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const { MongoClient, ServerApiVersion } = require('mongodb');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

let ultimoQR = ''; 
let sock = null;

// --- 1. SERVIDOR WEB (Muestra el QR en tu URL de Render) ---
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (ultimoQR) {
        res.end(`
            <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
                <h1>🐾 PATITAS SOS - Sesión en MongoDB</h1>
                <p>Abre WhatsApp en tu celular, ve a <b>Dispositivos vinculados</b> y escanea este código:</p>
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(ultimoQR)}" alt="QR WhatsApp" style="border: 5px solid #ccc; border-radius: 10px; padding: 10px; background: white;" />
            </div>
        `);
    } else {
        res.end(`
            <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
                <h1>🚀 ¡El bot está conectado y guardado en MongoDB!</h1>
                <p>La sesión está segura en la nube y no se perderá por reinicios.</p>
            </div>
        `);
    }
}).listen(PORT, () => {
    console.log(`🌐 Servidor web escuchando en el puerto ${PORT}`);
});

// --- 2. CONEXIÓN A MONGODB ATLAS ---
const uri = process.env.MONGO_URI;
const clientMongo = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let dbCollection;
let authCollection;

async function conectarBD() {
    try {
        await clientMongo.connect();
        const database = clientMongo.db("patitas_sos_db");
        dbCollection = database.collection("encuestas");
        authCollection = database.collection("whatsapp_auth"); // Colección para guardar la sesión
        console.log("🗄️ ¡Conexión exitosa con la base de datos de MongoDB Atlas!");
        
        // Iniciamos el bot una vez conectada la BD
        iniciarBot();
    } catch (error) {
        console.error("❌ Error al conectar a MongoDB:", error);
    }
}

conectarBD();

// --- 3. ADAPTADOR DE SESIÓN EN MONGODB ---
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        try {
            const jsonString = JSON.stringify(data, BufferJSON.replacer);
            await collection.updateOne(
                { _id: id },
                { $set: { data: JSON.parse(jsonString) } },
                { upsert: true }
            );
        } catch (error) {
            console.error(`Error saving auth data for ${id}:`, error);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: id });
            if (doc && doc.data) {
                return JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`Error reading auth data for ${id}:`, error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {
            console.error(`Error removing auth data for ${id}:`, error);
        }
    };

    const creds = (await readData('creds')) || initAuthCreds();

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = await readData(`${type}-${id}`);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const key = `${category}-${id}`;
                        if (value) {
                            tasks.push(writeData(value, key));
                        } else {
                            tasks.push(removeData(key));
                        }
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    return {
        state,
        saveCreds: () => writeData(state.creds, 'creds')
    };
}

// --- 4. BOT DE WHATSAPP ---
async function iniciarBot() {
    const { state, saveCreds } = await useMongoDBAuthState(authCollection);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            ultimoQR = qr;
            console.log('📌 NUEVO CÓDIGO QR GENERADO (Disponible en tu URL de Render)');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            ultimoQR = ''; 
            console.log('🚀 ¡El bot de PATITAS SOS está 100% activo y conectado (Sesión guardada en MongoDB)!');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada (Código: ${statusCode}). Reintentando en 3 segundos...`);
            
            if (shouldReconnect) {
                setTimeout(() => {
                    iniciarBot();
                }, 3000);
            } else {
                console.log('❌ Sesión cerrada por cierre de sesión.');
            }
        }
    });

    const sesionesUsuario = {};
    const TIEMPO_MAXIMO = 5 * 60 * 1000;

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        const mensajeTexto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const texto = mensajeTexto.trim().toLowerCase();

        // 1. DISPARADOR INICIAL
        if (texto.includes('encuesta patitas sos')) {
            if (sesionesUsuario[chatId] && sesionesUsuario[chatId].temporizador) {
                clearTimeout(sesionesUsuario[chatId].temporizador);
            }

            sesionesUsuario[chatId] = { 
                paso: 1, 
                respuestas: [],
                temporizador: setTimeout(() => {
                    delete sesionesUsuario[chatId];
                }, TIEMPO_MAXIMO)
            };
            
            const respuestaInicial = '¡Hola! 🐶 Gracias por ayudarnos con PATITAS SOS. Queremos ofrecer paseos y cuidados en Cerro de Pasco para financiar el rescate de perritos de la calle.\n\n¿Nos regalas 1 minuto?\n\n🐶 ¿Te interesaría un servicio de paseo de perros? 🐾\n\n*Responde solo con el número de tu opción:*\n1️⃣ ✅ SÍ\n2️⃣ ❌ NO';
            
            try {
                await sock.sendMessage(chatId, { 
                    image: fs.readFileSync('./intro.jpg'), 
                    caption: respuestaInicial 
                });
            } catch (error) {
                console.error("❌ No se pudo enviar la imagen intro.jpg:", error);
                await sock.sendMessage(chatId, { text: respuestaInicial });
            }
            return;
        }

        // 2. FLUJO DE PREGUNTAS
        if (sesionesUsuario[chatId]) {
            const usuario = sesionesUsuario[chatId];
            clearTimeout(usuario.temporizador);
            usuario.temporizador = setTimeout(() => { delete sesionesUsuario[chatId]; }, TIEMPO_MAXIMO);

            if (usuario.paso === 1) {
                if (['1', '2'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 2;
                    await sock.sendMessage(chatId, { text: '💸 ¿Cuánto estarías dispuesto(a) a pagar por un paseo de 45 a 60 minutos? ⏱️\n\n*Responde solo con el número de tu opción:*\n1️⃣ 🪙 Menos de S/10\n2️⃣ 💵 S/10 a S/15\n3️⃣ 💰 Más de S/15' });
                }
            } 
            else if (usuario.paso === 2) {
                if (['1', '2', '3'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 3;
                    await sock.sendMessage(chatId, { text: '🛡️ ¿Qué beneficios te darían más confianza? ✨\n\n*Responde solo con el número de tu opción:*\n1️⃣ 📍 Ubicación en tiempo real\n2️⃣ 📸 Fotos o videos durante el paseo\n3️⃣ 🏡 Recojo y retorno a domicilio' });
                }
            } 
            else if (usuario.paso === 3) {
                if (['1', '2', '3'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 4;
                    await sock.sendMessage(chatId, { text: '📅 ¿Con qué frecuencia lo usarías? 🐕\n\n*Responde solo con el número de tu opción:*\n1️⃣ ☀️ Todos los días\n2️⃣ 🏃 2 o 3 veces por semana\n3️⃣ 🗓️ Una vez por semana' });
                }
            }
            else if (usuario.paso === 4) {
                if (['1', '2', '3'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 5;
                    await sock.sendMessage(chatId, { text: '🗺️ ¿En qué distrito o zona vives? 🏡\n\n*Escribe tu respuesta aquí abajo:*' });
                }
            }
            else if (usuario.paso === 5) {
                let distritoEscrito = mensajeTexto.trim(); 
                const nombre = msg.pushName || 'Amigo/a de las patitas';

                try {
                    if (dbCollection) {
                        await dbCollection.insertOne({
                            nombre: nombre,
                            p1: usuario.respuestas[0],
                            p2: usuario.respuestas[1],
                            p3: usuario.respuestas[2],
                            p4: usuario.respuestas[3],
                            distrito: distritoEscrito,
                            fecha: new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })
                        });
                    }
                } catch (error) {
                    console.error("❌ Error al insertar el registro:", error);
                }

                const mensajeFinal = '¡Agradecemos mucho tu participación! 🌟 Tus respuestas nos ayudarán a brindarte la mejor experiencia y seguridad posible. 🛡️\n\nTe estaremos avisando cuando lancemos el servicio. 🏡 ¡Que tengas un excelente día!';
                await sock.sendMessage(chatId, { text: mensajeFinal });
                
                clearTimeout(usuario.temporizador);
                delete sesionesUsuario[chatId];
            }
        }
    });
}
