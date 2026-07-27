const http = require('http');
const fs = require('fs'); // Módulo para leer archivos locales como intro.jpg
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
                <h1>🐾 PATITAS SOS - Vinculación con Baileys</h1>
                <p>Abre WhatsApp en tu celular, ve a <b>Dispositivos vinculados</b> y escanea este código:</p>
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(ultimoQR)}" alt="QR WhatsApp" style="border: 5px solid #ccc; border-radius: 10px; padding: 10px; background: white;" />
            </div>
        `);
    } else {
        res.end(`
            <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
                <h1>🚀 ¡El bot ya está conectado o iniciando!</h1>
                <p>Si ya escaneaste el QR, el sistema está operando con normalidad.</p>
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

async function conectarBD() {
    try {
        await clientMongo.connect();
        const database = clientMongo.db("patitas_sos_db");
        dbCollection = database.collection("encuestas");
        console.log("🗄️ ¡Conexión exitosa con la base de datos de MongoDB Atlas!");
    } catch (error) {
        console.error("❌ Error al conectar a MongoDB:", error);
    }
}

conectarBD();

// --- 3. BOT DE WHATSAPP ---
async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
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
            console.log('🚀 ¡El bot de PATITAS SOS está 100% activo y conectado en la nube!');
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
                console.log('❌ Sesión cerrada. Es necesario volver a escanear el QR.');
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

        // 1. DISPARADOR INICIAL (ENVÍA intro.jpg DESDE EL REPOSITORIO)
        if (texto.includes('encuesta de patitas sos')) {
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
            
            const respuestaInicial = '¡Hola! 🐶 Gracias por ayudarnos con PATITAS SOS. Queremos ofrecer paseos y cuidados en Cerro de Pasco para financiar el rescate de perritos de la calle.\n\n¿Nos regalas 1 minuto? *Respóndeme solo con el número de tu opción (1, 2 o 3):*\n\n*Pregunta 1:* ¿Con qué frecuencia tienes tiempo para pasear a tu perrito?\n1️⃣ Todos los días\n2️⃣ 2 a 3 veces por semana\n3️⃣ Casi nunca por falta de tiempo';
            
            try {
                // Lee la imagen 'intro.jpg' directamente de la carpeta del proyecto en Render/GitHub
                await sock.sendMessage(chatId, { 
                    image: fs.readFileSync('./intro.jpg'), 
                    caption: respuestaInicial 
                });
            } catch (error) {
                console.error("❌ No se pudo enviar la imagen intro.jpg:", error);
                // Si por alguna razón no encuentra la imagen, envía al menos el texto para que el flujo no se rompa
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
                if (['1', '2', '3'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 2;
                    await sock.sendMessage(chatId, { text: '¡Entendido! 📝\n\n*Pregunta 2:* Sabiendo cómo es el clima aquí en Cerro de Pasco, ¿el frío o la lluvia te impiden sacarlo a pasear?\n1️⃣ Sí, mucho 🥶\n2️⃣ A veces ⛅\n3️⃣ No, sale igual ☀️' });
                }
            } 
            else if (usuario.paso === 2) {
                if (['1', '2', '3'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 3;
                    await sock.sendMessage(chatId, { text: '¡Excelente! 🚀\n\n*Pregunta 3:* Si existiera un servicio de total confianza para pasear o cuidar a tu mascota en casa, y supieras que tu pago ayuda a perros rescatados, ¿lo probarías?\n1️⃣ ¡Sí, de todas maneras!\n2️⃣ Tal vez (depende del precio)\n3️⃣ No, prefiero hacerlo yo' });
                }
            } 
            else if (usuario.paso === 3) {
                if (['1', '2', '3'].includes(texto)) {
                    usuario.respuestas.push(texto);
                    usuario.paso = 4;
                    await sock.sendMessage(chatId, { text: '¡Casi listos! 📝\n\n*Último paso:* Para poder avisarte cuando lancemos oficialmente nuestros servicios, por favor *escribe aquí abajo tu número de celular o WhatsApp*:' });
                }
            }
            else if (usuario.paso === 4) {
                let numeroEscrito = mensajeTexto.trim(); 
                const nombre = msg.pushName || 'Amigo/a de las patitas';

                try {
                    if (dbCollection) {
                        await dbCollection.insertOne({
                            nombre: nombre,
                            telefono: numeroEscrito,
                            p1: usuario.respuestas[0],
                            p2: usuario.respuestas[1],
                            p3: usuario.respuestas[2],
                            fecha: new Date().toLocaleString("es-PE", { timeZone: "America/Lima" })
                        });
                    }
                } catch (error) {
                    console.error("❌ Error al insertar el registro:", error);
                }

                await sock.sendMessage(chatId, { text: `¡Listo, ${nombre}! Has ayudado muchísimo a que PATITAS SOS sea una realidad muy pronto. 🐾 Guardaremos tu número (${numeroEscrito}). ¡Que tengan un gran día! ✨` });
                
                clearTimeout(usuario.temporizador);
                delete sesionesUsuario[chatId];
            }
        }
    });
}

iniciarBot();
