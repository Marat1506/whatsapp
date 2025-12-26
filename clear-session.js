import { existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const authFolder = join(__dirname, 'auth_info_baileys');

console.log('🧹 Очистка сессии WhatsApp...\n');

if (existsSync(authFolder)) {
  try {
    rmSync(authFolder, { recursive: true, force: true });
    console.log('✅ Сессия успешно удалена!');
    console.log('   Теперь при следующем запуске потребуется новый QR-код.\n');
  } catch (error) {
    console.error('❌ Ошибка при удалении сессии:', error.message);
    console.log('\n💡 Попробуйте удалить папку auth_info_baileys вручную.\n');
    process.exit(1);
  }
} else {
  console.log('ℹ️  Папка auth_info_baileys не найдена.');
  console.log('   Сессия уже очищена или еще не создавалась.\n');
}

