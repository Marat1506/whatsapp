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
import { existsSync, rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function connectToWhatsApp(onReady) {
  const authFolder = join(__dirname, 'auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  let version;
  try {
    const versionInfo = await fetchLatestBaileysVersion();
    version = versionInfo.version;
  } catch (error) {
    version = [2, 2413, 1, 1];
  }

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    connectTimeoutMs: 90_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 10_000,
    retryRequestDelayMs: 250,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    fireInitQueries: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    getMessage: async (key) => {
      return {
        conversation: 'Сообщение не найдено',
      };
    },
    browser: ['WhatsApp Baileys', 'Chrome', '1.0.0'],
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== ОТСКАНИРУЙТЕ QR-КОД ===\n');
      console.log('WhatsApp → Настройки → Связанные устройства → Связать устройство\n');
      qrcode.generate(qr, { small: true });
      console.log('\n');
      return;
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const errorMessage = lastDisconnect?.error?.message || '';

      if (statusCode === DisconnectReason.timedOut) {
        console.log('⏱️  Таймаут подключения');
        if (errorMessage) {
          console.log(`Ошибка: ${errorMessage}`);
        }
        console.log('Попытка переподключения через 5 секунд...\n');
        setTimeout(() => {
          if (shouldReconnect) {
            connectToWhatsApp(onReady);
          }
        }, 5000);
      } else if (statusCode === DisconnectReason.connectionClosed || 
                 statusCode === DisconnectReason.connectionLost) {
        console.log('🔌 Соединение разорвано');
        if (errorMessage) {
          console.log(`Ошибка: ${errorMessage}`);
        }
        console.log('Попытка переподключения через 5 секунд...\n');
        setTimeout(() => {
          if (shouldReconnect) {
            connectToWhatsApp(onReady);
          }
        }, 5000);
      } else {
        if (lastDisconnect?.error) {
          console.log('Ошибка:', lastDisconnect.error.message || lastDisconnect.error);
          if (statusCode === DisconnectReason.badSession) {
            console.log('⚠️  Удалите папку auth_info_baileys и перезапустите');
          }
        }

        if (shouldReconnect) {
          setTimeout(() => {
            connectToWhatsApp(onReady);
          }, 3000);
        } else {
          console.log('Вы вышли из WhatsApp. Удалите папку auth_info_baileys и перезапустите.');
        }
      }
    } else if (connection === 'open') {
      console.log('✅ Подключено к WhatsApp\n');
      if (onReady) {
        onReady(sock);
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
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

function formatPhoneToJID(phoneNumber) {
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  
  if (!cleanNumber || cleanNumber.length < 10) {
    throw new Error('Неверный формат номера телефона');
  }

  return `${cleanNumber}@s.whatsapp.net`;
}

async function checkIfRegistered(sock, jid) {
  try {
    const [result] = await sock.onWhatsApp(jid);
    return result?.exists || false;
  } catch (error) {
    console.error('Ошибка при проверке номера:', error.message);
    return false;
  }
}

async function sendMessage(sock, phoneNumber, message) {
  try {
    const jid = formatPhoneToJID(phoneNumber);
    const isRegistered = await checkIfRegistered(sock, jid);
    
    if (!isRegistered) {
      console.error('❌ Номер не зарегистрирован в WhatsApp');
      return { success: false, error: 'Номер не зарегистрирован в WhatsApp' };
    }

    await sock.sendMessage(jid, { text: message });
    console.log('✅ Сообщение отправлено');
    return { success: true, message: 'Сообщение отправлено' };
  } catch (error) {
    if (error.status === 404 || error.output?.statusCode === 404) {
      console.error('❌ Номер не зарегистрирован в WhatsApp');
      return { success: false, error: 'Номер не зарегистрирован в WhatsApp' };
    } else if (error.message?.includes('not-a-whatsapp-user') || 
               error.message?.includes('not registered')) {
      console.error('❌ Пользователь не использует WhatsApp');
      return { success: false, error: 'Пользователь не использует WhatsApp' };
    } else {
      console.error('❌ Ошибка:', error.message);
      return { success: false, error: error.message };
    }
  }
}

function createCLI(sock) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askForMessage = () => {
    rl.question('\nВведите номер телефона (с +) или "exit" для выхода: ', async (phone) => {
      if (phone.toLowerCase() === 'exit') {
        console.log('Выход...');
        rl.close();
        process.exit(0);
        return;
      }

      rl.question('Введите текст сообщения: ', async (text) => {
        if (!text.trim()) {
          console.log('❌ Сообщение не может быть пустым');
          askForMessage();
          return;
        }

        await sendMessage(sock, phone, text);
        askForMessage();
      });
    });
  };

  return askForMessage;
}

function clearAuthSession() {
  const authFolder = join(__dirname, 'auth_info_baileys');
  if (existsSync(authFolder)) {
    try {
      rmSync(authFolder, { recursive: true, force: true });
      console.log('✅ Старая сессия удалена. Потребуется новый QR-код.\n');
      return true;
    } catch (error) {
      console.error('❌ Ошибка при удалении сессии:', error.message);
      return false;
    }
  }
  return false;
}

async function main() {
  console.log('🚀 Запуск WhatsApp приложения...\n');

  let isConnected = false;

  const onReady = (sock) => {
    if (!isConnected) {
      isConnected = true;
      console.log('='.repeat(50));
      console.log('Приложение готово к работе!');
      console.log('='.repeat(50));
      
      const askForMessage = createCLI(sock);
      askForMessage();

      global.whatsappSocket = sock;
      global.sendWhatsAppMessage = (phone, text) => sendMessage(sock, phone, text);
    }
  };

  await connectToWhatsApp(onReady);
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
