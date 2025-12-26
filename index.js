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

// Функция для подключения к WhatsApp
async function connectToWhatsApp() {
  const startTime = Date.now();
  
  // Путь для сохранения сессии
  const authFolder = join(__dirname, 'auth_info_baileys');

  // Загружаем или создаем состояние авторизации
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  
  // Проверяем, есть ли сохраненная сессия
  if (state.creds.registered) {
    console.log('📂 Найдена сохраненная сессия. Попытка восстановления...');
  } else {
    console.log('🆕 Новая сессия. Потребуется сканирование QR-кода.');
  }
  
  // Таймер для отслеживания времени подключения
  const connectionTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > 10 && elapsed % 10 === 0) {
      console.log(`⏳ Подключение в процессе... (прошло ${elapsed} секунд)`);
    }
  }, 1000);

  // Получаем последнюю версию Baileys
  let version;
  try {
    console.log('Получение версии WhatsApp...');
    const versionInfo = await fetchLatestBaileysVersion();
    version = versionInfo.version;
    console.log(`Используется версия: ${version.join('.')}`);
  } catch (error) {
    console.warn('Не удалось получить последнюю версию, используется версия по умолчанию');
    console.warn('Ошибка:', error.message);
    // Используем последнюю известную версию
    version = [2, 2413, 1, 1];
  }

  // Создаем сокет для подключения
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }), // Отключаем лишние логи
    printQRInTerminal: false, // Будем выводить QR вручную
    connectTimeoutMs: 90_000, // Увеличиваем таймаут подключения до 90 секунд
    defaultQueryTimeoutMs: 60_000, // Таймаут для запросов
    keepAliveIntervalMs: 10_000, // Интервал keep-alive
    retryRequestDelayMs: 250, // Задержка перед повторной попыткой запроса
    generateHighQualityLinkPreview: false, // Отключаем генерацию превью для ускорения
    syncFullHistory: false, // Не синхронизируем полную историю для ускорения
    fireInitQueries: true, // Выполняем начальные запросы
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    getMessage: async (key) => {
      return {
        conversation: 'Сообщение не найдено',
      };
    },
    // Настройки WebSocket
    browser: ['WhatsApp Baileys', 'Chrome', '1.0.0'],
    markOnlineOnConnect: true,
  });

  // Обработка событий подключения
  sock.ev.on('creds.update', saveCreds);

  // Обработка QR-кода и состояний подключения
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isNewLogin, isOnline } = update;

    // Детальное логирование для диагностики
    if (connection) {
      console.log(`📡 Состояние подключения: ${connection}`);
    }

    // Обработка QR-кода
    if (qr) {
      clearInterval(connectionTimer); // Останавливаем таймер
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log('\n' + '='.repeat(60));
      console.log('=== ОТСКАНИРУЙТЕ QR-КОД ДЛЯ ПОДКЛЮЧЕНИЯ К WHATSAPP ===');
      console.log('='.repeat(60));
      console.log(`⏱️  Время до получения QR-кода: ${elapsed} секунд\n`);
      console.log('📱 Инструкция:');
      console.log('   1. Откройте WhatsApp на телефоне');
      console.log('   2. Настройки → Связанные устройства');
      console.log('   3. Нажмите "Связать устройство"');
      console.log('   4. Отсканируйте QR-код ниже:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n⏳ QR-код действителен в течение нескольких минут...\n');
      return; // Не обрабатываем другие события, пока ждем сканирования
    }

    // Логируем другие важные состояния
    if (isNewLogin !== undefined) {
      console.log(`🔐 Новый вход: ${isNewLogin}`);
    }
    if (isOnline !== undefined) {
      console.log(`🌐 Онлайн статус: ${isOnline}`);
    }

    if (connection === 'close') {
      clearInterval(connectionTimer); // Останавливаем таймер
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      const errorMessage = lastDisconnect?.error?.message || '';
      
      console.log(`\n⏱️  Время попытки подключения: ${elapsed} секунд`);

      if (statusCode === DisconnectReason.timedOut) {
        console.log('\n⏱️  ТАЙМАУТ ПОДКЛЮЧЕНИЯ');
        console.log('='.repeat(60));
        console.log('⚠️  ВАЖНО: Убедитесь, что десктопная версия WhatsApp полностью закрыта!');
        console.log('\nВозможные причины:');
        console.log('   1. Десктопная версия WhatsApp все еще запущена');
        console.log('      → Проверьте диспетчер задач (Ctrl+Shift+Esc)');
        console.log('      → Найдите процесс "WhatsApp" и завершите его');
        console.log('   2. Проблемы с интернет-соединением');
        console.log('   3. Файрвол или антивирус блокирует соединение');
        console.log('   4. Проблемы с DNS');
        console.log('   5. Блокировка со стороны провайдера');
        console.log('   6. Конфликт с другой активной сессией WhatsApp');
        if (errorMessage) {
          console.log(`\nДетали ошибки: ${errorMessage}`);
        }
        console.log('\n💡 Рекомендации:');
        console.log('   - Закройте ВСЕ приложения WhatsApp (десктоп, веб-версию)');
        console.log('   - Проверьте интернет-соединение');
        console.log('   - Если проблема сохраняется, удалите папку auth_info_baileys');
        console.log('='.repeat(60));
        console.log('\nПопытка переподключения через 5 секунд...\n');
        setTimeout(() => {
          if (shouldReconnect) {
            connectToWhatsApp();
          }
        }, 5000);
      } else if (statusCode === DisconnectReason.connectionClosed || 
                 statusCode === DisconnectReason.connectionLost) {
        console.log('🔌 Соединение разорвано. Возможные причины:');
        console.log('   ⚠️  ВАЖНО: Проверьте, не запущена ли десктопная версия WhatsApp!');
        console.log('   - Другая сессия WhatsApp активна на этом номере');
        console.log('   - Проблемы с сетью');
        if (errorMessage) {
          console.log(`   - Детали ошибки: ${errorMessage}`);
        }
        console.log('\nПопытка переподключения через 5 секунд...\n');
        setTimeout(() => {
          if (shouldReconnect) {
            connectToWhatsApp();
          }
        }, 5000);
      } else {
        console.log('Соединение закрыто. Код:', statusCode);
        if (lastDisconnect?.error) {
          console.log('Ошибка:', lastDisconnect.error.message || lastDisconnect.error);
          if (statusCode === DisconnectReason.badSession) {
            console.log('⚠️  Обнаружена проблема с сессией. Попробуйте удалить папку auth_info_baileys и перезапустить.');
          }
        }

        if (shouldReconnect) {
          console.log('Переподключение через 3 секунды...');
          setTimeout(() => {
            connectToWhatsApp();
          }, 3000);
        } else {
          console.log('Вы вышли из WhatsApp. Удалите папку auth_info_baileys и перезапустите приложение.');
        }
      }
    } else if (connection === 'open') {
      console.log('✅ Успешно подключено к WhatsApp!');
      console.log('Готово к отправке сообщений.\n');
    } else if (connection === 'connecting') {
      console.log('🔄 Подключение к WhatsApp...');
      console.log('   Ожидание QR-кода или восстановления сессии...');
    } else if (connection === 'open') {
      clearInterval(connectionTimer); // Останавливаем таймер
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log(`✅ Соединение установлено! (за ${elapsed} секунд)`);
    }
  });

  // Обработка входящих сообщений
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === 'notify') {
      console.log('📨 Получено сообщение от:', msg.key.remoteJid);
      if (msg.message?.conversation) {
        console.log('Текст:', msg.message.conversation);
      }
    }
  });

  return sock;
}

// Функция для форматирования номера телефона в JID
function formatPhoneToJID(phoneNumber) {
  // Убираем все кроме цифр
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  
  // Проверяем формат номера
  if (!cleanNumber || cleanNumber.length < 10) {
    throw new Error('Неверный формат номера телефона');
  }

  // Формируем JID (идентификатор контакта)
  // Формат: номер@s.whatsapp.net (номер должен быть в международном формате без +)
  return `${cleanNumber}@s.whatsapp.net`;
}

// Функция для проверки, зарегистрирован ли номер в WhatsApp
async function checkIfRegistered(sock, jid) {
  try {
    const [result] = await sock.onWhatsApp(jid);
    return result?.exists || false;
  } catch (error) {
    console.error('Ошибка при проверке номера:', error.message);
    return false;
  }
}

// Функция для отправки сообщения
async function sendMessage(sock, phoneNumber, message) {
  try {
    // Форматируем номер в JID
    const jid = formatPhoneToJID(phoneNumber);
    
    console.log(`\nПроверка номера: ${jid}`);

    // Проверяем, зарегистрирован ли номер в WhatsApp
    const isRegistered = await checkIfRegistered(sock, jid);
    
    if (!isRegistered) {
      console.error('❌ Ошибка: Номер телефона не зарегистрирован в WhatsApp');
      return { success: false, error: 'Номер не зарегистрирован в WhatsApp' };
    }

    console.log(`✅ Номер зарегистрирован. Отправка сообщения...`);

    // Отправляем сообщение
    await sock.sendMessage(jid, { text: message });

    console.log('✅ Сообщение успешно отправлено!');
    return { success: true, message: 'Сообщение отправлено' };
  } catch (error) {
    // Обработка различных типов ошибок
    if (error.status === 404 || error.output?.statusCode === 404) {
      console.error('❌ Ошибка: Номер телефона не зарегистрирован в WhatsApp');
      return { success: false, error: 'Номер не зарегистрирован в WhatsApp' };
    } else if (error.message?.includes('not-a-whatsapp-user') || 
               error.message?.includes('not registered')) {
      console.error('❌ Ошибка: Пользователь не использует WhatsApp');
      return { success: false, error: 'Пользователь не использует WhatsApp' };
    } else {
      console.error('❌ Ошибка при отправке сообщения:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// Функция для создания CLI интерфейса
function createCLI(sock) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askForMessage = () => {
    rl.question('\nВведите номер телефона (с +) или "exit" для выхода: ', async (phone) => {
      if (phone.toLowerCase() === 'exit') {
        console.log('Выход из приложения...');
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

// Функция для очистки старой сессии
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

// Основная функция
async function main() {
  console.log('🚀 Запуск WhatsApp приложения...\n');
  console.log('⚠️  ВАЖНО: Перед запуском убедитесь, что:');
  console.log('   1. Десктопная версия WhatsApp ЗАКРЫТА (полностью выйдите из приложения)');
  console.log('   2. Проверьте диспетчер задач (Ctrl+Shift+Esc) - процесс WhatsApp не должен быть запущен');
  console.log('   3. Один номер телефона не может быть подключен одновременно к нескольким клиентам\n');
  console.log('💡 Если возникают проблемы с подключением:');
  console.log('   1. Проверьте интернет-соединение');
  console.log('   2. Убедитесь, что файрвол не блокирует соединение');
  console.log('   3. Попробуйте отключить VPN, если используете');
  console.log('   4. Проверьте, не блокирует ли антивирус соединение');
  console.log('   5. Если проблема сохраняется, попробуйте удалить папку auth_info_baileys\n');

  // Проверяем наличие старой сессии
  const authFolder = join(__dirname, 'auth_info_baileys');
  if (existsSync(authFolder)) {
    console.log('📂 Обнаружена сохраненная сессия.');
    console.log('   Если возникают проблемы, удалите папку auth_info_baileys и перезапустите.\n');
  }

  const sock = await connectToWhatsApp();
  let isConnected = false;

  // Ждем подключения перед отправкой сообщений
  sock.ev.on('connection.update', async (update) => {
    if (update.connection === 'open' && !isConnected) {
      isConnected = true;
      console.log('\n' + '='.repeat(50));
      console.log('Приложение готово к работе!');
      console.log('='.repeat(50));
      
      // Создаем CLI интерфейс
      const askForMessage = createCLI(sock);
      askForMessage();

      // Также экспортируем функции для программного использования
      global.whatsappSocket = sock;
      global.sendWhatsAppMessage = (phone, text) => sendMessage(sock, phone, text);
    }
  });
}

// Запускаем приложение
main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});

