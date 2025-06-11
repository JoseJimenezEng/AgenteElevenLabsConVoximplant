const dotenv = require('dotenv');
dotenv.config(); // Cargar variables de entorno desde .env
const WebSocket = require('ws');
const crypto = require('crypto');
const PORT = process.env.PORT; // Puerto del WebSocket Server
const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=" + process.env.ELEVENLABS_AGENT_ID; // URL del WebSocket de ElevenLabs
const CHUNK_SIZE = 1000; // Tamaño del chunk en base64
const CHUNK_INTERVAL = 100; // Intervalo de enivo de chunks 
const wssVox = new WebSocket.Server({ port: PORT });
const MAX_ROOMS = 3; // Límite máximo de rooms
const usarAudioBufferManual = false; // Usar buffer manual de audio para el agente



// Inciamos el WEB SOCKET SERVER y las rooms ------------------------------------------

const rooms = new Map();

console.log(`🚀 WebSocket Server listening on port ${PORT}...`);

wssVox.on('connection', (wsVox) => {
    // Verificar si se ha alcanzado el límite de rooms
    if (rooms.size >= MAX_ROOMS) {
        // Enviar mensaje de que está lleno al cliente de Voximplant
        const siteFullMessage = {
            event: 'error',
            message: 'Sitio lleno',
            code: 'ROOM_LIMIT_EXCEEDED'
        };

        wsVox.send(JSON.stringify(siteFullMessage));

        // Cerrar la conexión
        wsVox.close();
        return;
    }
    const roomId = crypto.randomBytes(16).toString('hex'); // Generar un ID único para la sala

    wsVox.roomId = roomId;

    rooms.set(roomId, {
        wsVox: wsVox,
        elevenLabsWs: null,
        audioBuffer: Buffer.alloc(0), // Buffer para almacenar los datos de audio del agnete
        chunkSendTimer: null // Timer para el envío de chunks
    });

    console.log(`✅ WebSocket VOXIMPLANT cliente conectado. Room ID: ${roomId}`);
    console.log(`Rooms activas: ${rooms.size}/${MAX_ROOMS}`);




    // INICIAMOS LA CONEXIÓN A ELEVENLABS ------------------------------------------


    const elevenLabsWs = new WebSocket(ELEVENLABS_WS_URL);

    rooms.get(roomId).elevenLabsWs = elevenLabsWs;



    // Cuando se abre la conexión a ElevenLabs, enviamos un mensaje de inicio de conversación ------------------------------------------

    elevenLabsWs.on('open', () => {
        console.log(`✅ Conectado a ElevenL WebSocket para el room ${roomId}`);
        const initMsg = {
            "type": "conversation_initiation_client_data",
            "dynamic_variables": {
                "name": `Juan David`,
                "celular": "573028571257",
                "mail": "jdjimenezle@gmail.com",
                "interes": "Ha mostrado interés inicial en Salinas del Sol, específicamente del apartamento tipo C, pero aún no ha tomado ninguna decisión"
            }
        };
        elevenLabsWs.send(JSON.stringify(initMsg)); // Enviamos el mensaje de inicio de conversación con datos del cliente
    });


    const sendAudioChunks = (roomData) => {

        // Si ya hay un timer activo, lo cancelamos para evitar envíos duplicados
        if (roomData.chunkSendTimer) {
            clearTimeout(roomData.chunkSendTimer);
        }


        const sendNextChunk = () => {
            // Si el buffer de audio tiene suficientes datos, enviamos un chunk
            if (roomData.audioBuffer.length >= CHUNK_SIZE) {

                // Extraemos un chunk del buffer de audio
                // y lo eliminamos del buffer para no enviarlo de nuevo
                const chunkData = roomData.audioBuffer.slice(0, CHUNK_SIZE);
                roomData.audioBuffer = roomData.audioBuffer.slice(CHUNK_SIZE);

                // Creamos el objeto de datos de audio para enviar
                const audioData = {
                    event: 'media',
                    media: {
                        payload: chunkData.toString("base64"),
                    }
                };

                // Enviamos el chunk de audio al WebSocket VOXIMPLATN
                if (roomData.wsVox.readyState === WebSocket.OPEN) {
                    roomData.wsVox.send(JSON.stringify(audioData));

                }

                // Programamos el envío del siguiente chunk después de un intervalo
                if (roomData.audioBuffer.length >= CHUNK_SIZE) {
                    roomData.chunkSendTimer = setTimeout(sendNextChunk, CHUNK_INTERVAL);
                } else {
                    // Si no hay más chunks para enviar, limpiamos el timer
                    roomData.chunkSendTimer = null;
                }
            }
        };

        // Iniciamos el envío de chunks 
        sendNextChunk();
    };





    // Escuchamos los mensajes del WebSocket de ElevenLabs para que el agente envíe audio al usuario ------------------------------------------

    elevenLabsWs.on('message', (dataElevenLabs) => {
        try {
            const message = JSON.parse(dataElevenLabs);

            // Según el tipo de mensaje recibido, tomamos diferentes acciones
            switch (message.type) {

                // Definimos el formato de audio entre ellos (DEBE SER EL MISMO ENTRE VOXIMPLANT Y ELEVENLABS)
                case "conversation_initiation_metadata":
                    const startConnection = {
                        event: 'start',
                        sequenceNumber: 0,
                        start: { mediaFormat: { encoding: 'ulaw', sampleRate: 8000 } }
                    };

                    // Enviamos el mensaje de inicio de conexión al WebSocket VOXIMPLANT
                    if (wsVox.readyState === WebSocket.OPEN) {
                        wsVox.send(JSON.stringify(startConnection));
                    }
                    break;

                // Cuando recibimos un chunk de audio del agente, lo procesamos
                case "audio":
                    if (message.audio_event?.audio_base_64 && usarAudioBufferManual) {
                        const currentRoomData = rooms.get(roomId);
                        const receivedAudio = Buffer.from(message.audio_event.audio_base_64, "base64");
                        // Añadimos el audio recibido al buffer de audio del room actual
                        currentRoomData.audioBuffer = Buffer.concat([currentRoomData.audioBuffer, receivedAudio]);

                        sendAudioChunks(currentRoomData);
                        // usamos la función sendAudioChunks para enviar los chunks de audio al WebSocket VOXIMPLANT y Voximplant los envía al usuario

                    } else {
                        const roomData = rooms.get(roomId);
                        // Si no usamos buffer manual, pero el de VOXIMPLATN , simplemente enviamos el audio recibido directamente
                        const receivedAudio = Buffer.from(message.audio_event.audio_base_64, "base64");
                        const audioData = {
                            event: 'media',
                            media: {
                                payload: receivedAudio.toString("base64"),
                            }
                        };

                        // Enviamos el chunk de audio al WebSocket VOXIMPLATN
                        if (roomData.wsVox.readyState === WebSocket.OPEN) {
                            roomData.wsVox.send(JSON.stringify(audioData));

                        }
                    }
                    break;

                case "ping":
                    // Si recibimos un ping, respondemos con un pong
                    // Esto es importante para mantener la conexión activa
                    if (message.ping_event?.event_id) {
                        const pongResponse = {
                            type: "pong",
                            event_id: message.ping_event.event_id,
                        };
                        elevenLabsWs.send(JSON.stringify(pongResponse));
                    }
                    break;

                case "interruption":
                    if (usarAudioBufferManual) {
                        const interruptRoomData = rooms.get(roomId);
                        // Limpiamos el buffer de audio y cancelamos el timer de envío de chunks
                        interruptRoomData.audioBuffer = Buffer.alloc(0);
                        clearTimeout(interruptRoomData.chunkSendTimer);
                        console.log(`⚠️ Interrupción con BUFFER MANUAL detectada para room ${roomId}: limpiando buffer de audio.`);
                    } else {
                        wsVox.send(JSON.stringify("interruption"));
                        console.log(`⚠️ Interrupción con BUFFER DE VOXIMPLANT detectada para room ${roomId}: limpiando buffer de audio.`);
                    }
                    break;
                case "agent_response":
                    break;
                default:
                    console.log(`evento desconocido de ELEVENLABS en room ${roomId}: ${message.type}`);
            }
        } catch (error) {
            console.error(`Error en el parsing para room ${roomId}:`, error);
        }
    });

    elevenLabsWs.on('error', (error) => {
        console.error(`⚠️ Error en WebSocket de ElevenLabs para room ${roomId}:`, error);
    });

    elevenLabsWs.on('close', () => {
        console.log(`Conexión a ElevenLabs cerrada para room ${roomId}.`);
    });


    // 


    // Escuchamos los mensajes del WebSocket VOXIMPLANT para que el usuario envíe audio al agente ------------------------------------------

    wsVox.on("message", async (dataVox) => {
        try {
            const data = JSON.parse(dataVox);
            const currentRoomData = rooms.get(roomId);

            // procesamos los eventos recibidos del WebSocket VOXIMPLANT
            switch (data.event) {
                case "media":

                    // Todo el tiempo estamos recibiendo audio del usuario, pero debido al VAD de ElevenLabs, solo se detecta cuando el usuario está hablando.
                    if (currentRoomData.elevenLabsWs && currentRoomData.elevenLabsWs.readyState === WebSocket.OPEN) {
                        // Si el WebSocket de ElevenLabs está abierto, enviamos el audio del usuario a ElevenLabs
                        const audioMessage = {
                            user_audio_chunk: Buffer.from(
                                data.media.payload,
                                "base64"
                            ).toString("base64"),
                        };
                        currentRoomData.elevenLabsWs.send(JSON.stringify(audioMessage));
                    }
                    break;

                case "stop":
                    // Cuando recibimos un evento de stop, cerramos la conexión con ElevenLabs y limpiamos el buffer de audio
                    console.log(`Llamada finalizada para room ${roomId}`);

                    if (currentRoomData.elevenLabsWs) {
                        currentRoomData.elevenLabsWs.close();
                    }

                    // Limpiar el buffer de audio, reiniciar segundos y restablecer estado
                    currentRoomData.audioBuffer = Buffer.alloc(0);
                    currentRoomData.seconds = 0;
                    currentRoomData.isTalking = false;
                    break;

                default:
                    console.log(`evento desconocido de VOXMIPLANT en room ${roomId} `);
            }
        } catch (error) {
            console.error(`Error en el mensaje de VOX en el room ${roomId}:`, error);
        }
    });

    wsVox.on('close', () => {
        console.log(`❌ Conexión WebSocket VOX cerrada para room ${roomId}.`);

        // Al cerrar la conexión, también cerramos la conexión con ElevenLabs si está abierta
        const closingRoomData = rooms.get(roomId);
        if (closingRoomData) {
            if (closingRoomData.elevenLabsWs && closingRoomData.elevenLabsWs.readyState === WebSocket.OPEN) {
                closingRoomData.elevenLabsWs.close();
            }
        }

        // Limpiamos el buffer de audio y cancelamos el timer de envío de chunks
        rooms.delete(roomId);
        console.log(`Rooms activas después de desconexión: ${rooms.size}/${MAX_ROOMS}`);

    });

    wsVox.on('error', (err) => {
        console.error(`⚠️ Error en WebSocket VOX para room ${roomId}: ${err.message}`);
    });

    wsVox.send(JSON.stringify({
        event: 'connection',
        roomId: roomId,
        message: '🔗 Conexión establecida con el servidor WebSocket VOX para este cliente.'
    }));
});

