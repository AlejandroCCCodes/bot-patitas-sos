const http = require('http');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { MongoClient, ServerApiVersion } = require('mongodb');

let ultimoQR = ''; // Variable para almacenar el código QR actual

// --- 1. SERVIDOR WEB (Muestra el QR en la web y mantiene vivo a Render) ---
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (ultimoQR) {
        res.end(`
            <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
                <h1>🐾 PATITAS SOS - Vinculación de WhatsApp</h1>
                <p>Abre WhatsApp en tu celular, ve a <b>Dispositivos vinculados</b> y escanea este código:</p>
                <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(ultimoQR)}" alt="QR WhatsApp" style="border: 5px solid #ccc; border-radius: 10px; padding: 10px; background: white;" />
                <p style="color: gray; margin-top: 20px;">Si ya lo escaneaste, puedes cerrar esta pestaña.</p>
            </div>
        `);
    } else {
        res.end(`
            <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
                <h1>⏳ El bot está iniciando el navegador...</h1>
                <p>Actualiza esta página en unos 10 o 15 segundos para ver el código QR.</p>
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

// --- 3. CONFIGURACIÓN DEL BOT DE WHATSAPP (Optimizado para bajo consumo de RAM en Render) ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--single-process',
            '--disable-extensions'
        ]
    }
});

client.on('qr', (qr) => {
    ultimoQR = qr; // Guarda el QR para visualizarlo en la web
    console.log('📌 NUEVO CÓDIGO QR GENERADO (También disponible en tu URL de Render)');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🚀 ¡El bot de PATITAS SOS está 100% activo y listo en la nube!');
});

const sesionesUsuario = {};
const TIEMPO_MAXIMO = 5 * 60 * 1000;

async function guardarEnMongoDB(nombre, telefono, respuestas) {
    try {
        if (dbCollection) {
            await dbCollection.insertOne({
                nombre: nombre,
                telefono: telefono,
                p1: respuestas[0],
                p2: respuestas[1],
                p3: respuestas[2],
                fecha: new Date().toLocaleString()
            });
            console.log(`✅ ¡Encuesta guardada en la nube para ${nombre} (${telefono})!`);
        } else {
            console.log("⚠️ La base de datos aún no está lista.");
        }
    } catch (error) {
        console.error("❌ Error al insertar el registro:", error);
    }
}

client.on('message', async msg => {
    const chatId = msg.from;
    const texto = msg.body.trim().toLowerCase();

    // 1. DISPARADOR INICIAL
    if (texto.includes('encuesta de patitas sos')) {
        if (sesionesUsuario[chatId] && sesionesUsuario[chatId].temporizador) {
            clearTimeout(sesionesUsuario[chatId].temporizador);
        }

        sesionesUsuario[chatId] = { 
            paso: 1, 
            respuestas: [],
            temporizador: setTimeout(() => {
                delete sesionesUsuario[chatId];
                console.log(`⏱️ Sesión expirada por inactividad.`);
            }, TIEMPO_MAXIMO)
        };
        
        try {
            const media = MessageMedia.fromFilePath('./intro.mp4'); 
            await client.sendMessage(chatId, media, { 
                caption: '¡Hola! 🐶 Gracias por ayudarnos con PATITAS SOS. Queremos ofrecer paseos y cuidados en Cerro de Pasco para financiar el rescate de perritos de la calle.\n\n¿Nos regalas 1 minuto? *Respóndeme solo con el número de tu opción (1, 2 o 3):*\n\n*Pregunta 1:* ¿Con qué frecuencia tienes tiempo para pasear a tu perrito?\n1️⃣ Todos los días\n2️⃣ 2 a 3 veces por semana\n3️⃣ Casi nunca por falta de tiempo' 
            });
        } catch (error) {
            await client.sendMessage(chatId, '¡Hola! 🐶 Gracias por ayudarnos con PATITAS SOS. Queremos ofrecer paseos y cuidados en Cerro de Pasco para financiar la ayuda a perritos de la calle.\n\n¿Nos regalas 1 minuto? *Respóndeme solo con el número de tu opción (1, 2 o 3):*\n\n*Pregunta 1:* ¿Con qué frecuencia tienes tiempo para pasear a tu perrito?\n1️⃣ Todos los días\n2️⃣ 2 a 3 veces por semana\n3️⃣ Casi nunca por falta de tiempo');
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
                await client.sendMessage(chatId, '¡Entendido! 📝\n\n*Pregunta 2:* Sabiendo cómo es el clima aquí en Cerro de Pasco, ¿el frío o la lluvia te impiden sacarlo a pasear?\n1️⃣ Sí, mucho 🥶\n2️⃣ A veces ⛅\n3️⃣ No, sale igual ☀️');
            }
        } 
        else if (usuario.paso === 2) {
            if (['1', '2', '3'].includes(texto)) {
                usuario.respuestas.push(texto);
                usuario.paso = 3;
                await client.sendMessage(chatId, '¡Excelente! 🚀\n\n*Pregunta 3:* Si existiera un servicio de total confianza para pasear o cuidar a tu mascota en casa, y supieras que tu pago ayuda a perros rescatados, ¿lo probarías?\n1️⃣ ¡Sí, de todas maneras!\n2️⃣ Tal vez (depende del precio)\n3️⃣ No, prefiero hacerlo yo');
            }
        } 
        else if (usuario.paso === 3) {
            if (['1', '2', '3'].includes(texto)) {
                usuario.respuestas.push(texto);
                usuario.paso = 4;
                
                await client.sendMessage(chatId, '¡Casi listos! 📝\n\n*Último paso:* Para poder avisarte cuando lancemos oficialmente nuestros servicios, por favor *escribe aquí abajo tu número de celular o WhatsApp*:');
            }
        }
        else if (usuario.paso === 4) {
            let numeroEscrito = msg.body.trim(); 
            const contacto = await msg.getContact();
            const nombre = contacto.pushname || 'Amigo/a de las patitas';

            await guardarEnMongoDB(nombre, numeroEscrito, usuario.respuestas);
            
            await client.sendMessage(chatId, `¡Listo, ${nombre}! Has ayudado muchísimo a que PATITAS SOS sea una realidad muy pronto. 🐾 Guardaremos tu número (${numeroEscrito}). ¡Que tengan un gran día! ✨`);
            
            clearTimeout(usuario.temporizador);
            delete sesionesUsuario[chatId];
        }
    }
});

client.initialize();
