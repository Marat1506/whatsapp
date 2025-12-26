import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function connectToWhatsApp(onReady) {
  const { state, saveCreds } = await useMultiFileAuthState(join(__dirname, 'authInfo'));

  let version = [2, 2413, 1, 1];
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (e) {}

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    connectTimeoutMs: 90000,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    getMessage: async () => ({ conversation: 'Сообщение не найдено' }),
    browser: ['WhatsApp Baileys', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (update.qr) {
      console.log('\n=== ОТСКАНИРУЙТЕ QR-КОД ===\n');
      console.log('WhatsApp => Настройки-> Связанные устройства \n');
      qrcode.generate(update.qr, { small: true });
      console.log('\n');
      return;
    }

    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      if (statusCode === DisconnectReason.badSession) {
        console.log('Удалите папку authInfo и перезапустите');
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log('Вы вышли из WhatsApp. Удалите папку authInfo и перезапустите.');
      } else if (shouldReconnect) {
        const delay = statusCode === DisconnectReason.timedOut ? 5000 : 3000;
        console.log(`Переподключение через ${delay / 1000} секунд...\n`);
        setTimeout(() => connectToWhatsApp(onReady), delay);
      }
    } else if (update.connection === 'open') {
      console.log(' Подключено к WhatsApp\n');
      if (onReady) onReady(sock);
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      console.log('📨 Сообщение от:', msg.key.remoteJid);
      if (msg.message?.conversation) {
        console.log('Текст:', msg.message.conversation);
      }
    }
  });

  return sock;
}

async function sendMessage(sock, phone, text) {
  try {
    const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
    console.log('Сообщение отправлено');
  } catch (error) {
    const msg = error.message || '';
    if (error.status === 404 || error.output?.statusCode === 404 || msg.includes('not')) {
      console.error('Номер не зарегистрирован в WhatsApp');
    } else {
      console.error('Ошибка:', msg);
    }
  }
}

function createCLI(sock) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question('\nВведите номер телефона (с +) или "exit" для выхода: ', async (phone) => {
      if (phone.toLowerCase() === 'exit') {
        rl.close();
        process.exit(0);
        return;
      }

      rl.question('Введите текст сообщения: ', async (text) => {
        if (text.trim()) {
          await sendMessage(sock, phone, text);
        }
        ask();
      });
    });
  };

  return ask;
}

async function main() {
  let isConnected = false;
  await connectToWhatsApp((sock) => {
    if (!isConnected) {
      isConnected = true;
      console.log('='.repeat(50));
      console.log('Приложение готово к работе');
      console.log('='.repeat(50));
      createCLI(sock)();
      global.whatsappSocket = sock;
      global.sendWhatsAppMessage = (phone, text) => sendMessage(sock, phone, text);
    }
  });
}

main().catch((err) => {
  console.error('ошибка:', err);
  process.exit(1);
});
